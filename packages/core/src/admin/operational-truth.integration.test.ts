/**
 * Karar 0051 — yönetim ekranının dürüst ölçütleri, gerçek YEREL Postgres:
 * dikkat listesi (yalnızca aktif mağaza, durumlar), maliyet doğruluğu
 * (fiyatlanmamış çağrı), boru hattı kanıtı, denetim hedef çözümü ve
 * aktör/hedef filtresi.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listAdminEvents } from "./audit.ts";
import { AdminForbiddenError } from "./capabilities.ts";
import { getAdminOverview } from "./dashboard.ts";
import { listMerchantAttention } from "./merchant-attention.ts";
import { getPipelineEvidence } from "./pipeline-evidence.ts";

function assertLocal(): void {
  for (const name of ["DATABASE_URL", "DATABASE_URL_OWNER"]) {
    const host = new URL(process.env[name] ?? "").hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error(`${name} yerel degil; bu test yalnizca yerel veritabaninda calisir.`);
    }
  }
}

const TAG = `ot${Date.now().toString(36)}`;
const merchants: Record<string, number> = {};
const users: Record<string, { id: number; publicId: string }> = {};
const usageIds: number[] = [];
let db: Database;

const admin = () => ({ userId: users.admin?.id as number, role: "admin" as const });
const moderator = () => ({ userId: users.moderator?.id as number, role: "moderator" as const });

async function createMerchant(
  key: string,
  opts: { active?: boolean; sourceType?: string; verified?: boolean },
): Promise<number> {
  const id = await withOwnerClient(async (client) => {
    const res = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, is_active, feed_config)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        `${TAG}-${key}`,
        `${TAG} ${key}`,
        `${TAG}-${key}.test`,
        opts.sourceType ?? "xml_feed",
        opts.active ?? true,
        JSON.stringify(
          opts.sourceType === "shopify"
            ? { currency: "TRY", currency_verified: opts.verified ?? false }
            : {},
        ),
      ],
    );
    return Number(res.rows[0].id);
  });
  merchants[key] = id;
  return id;
}

async function run(merchantKey: string, status: string, startedAgo: string): Promise<void> {
  await withOwnerClient((client) =>
    client.query(
      `INSERT INTO ingest_run (merchant_id, started_at, finished_at, status, offers_seen,
                               offers_created, offers_updated)
       VALUES ($1, now() - $2::interval,
               CASE WHEN $3 = 'running' THEN NULL ELSE now() - $2::interval END, $3, 10, 4, 6)`,
      [merchants[merchantKey], startedAgo, status],
    ),
  );
}

beforeAll(async () => {
  assertLocal();
  db = getTestDb();
  await withOwnerClient(async (client) => {
    for (const role of ["admin", "moderator"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id, public_id",
        [`${TAG}-${role}@test.local`, role],
      );
      users[role] = { id: Number(res.rows[0].id), publicId: String(res.rows[0].public_id) };
    }
  });

  await createMerchant("fresh", {});
  await run("fresh", "success", "1 hour");
  await createMerchant("partial", {});
  await run("partial", "partial", "1 hour");
  await createMerchant("failed", {});
  await run("failed", "success", "3 days");
  await run("failed", "failed", "2 hours");
  await run("failed", "failed", "1 hour");
  await createMerchant("never", {});
  await createMerchant("stale", {});
  await run("stale", "success", "3 days");
  await createMerchant("stuck", {});
  await run("stuck", "success", "5 hours");
  await run("stuck", "running", "3 hours");
  await createMerchant("shopify", { sourceType: "shopify", verified: false });
  await run("shopify", "success", "1 hour");
  await createMerchant("inactive", { active: false });
  await run("inactive", "failed", "1 hour");
});

afterAll(async () => {
  const merchantIds = Object.values(merchants);
  const userIds = Object.values(users).map((u) => u.id);
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM ingest_run WHERE merchant_id = ANY($1)", [merchantIds]);
    await client.query("DELETE FROM api_usage WHERE id = ANY($1)", [usageIds]);
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [userIds]);
    await client.query(
      "DELETE FROM admin_audit_event WHERE target_type = 'app_user' AND target_id = ANY($1::text[])",
      [userIds.map(String)],
    );
    await client.query("DELETE FROM merchant WHERE id = ANY($1)", [merchantIds]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
  });
});

describe("dikkat gerektiren mağazalar", () => {
  it("yalnızca aktif mağazalar; durumlar doğru; kısmi ve taze mağaza listede yok", async () => {
    const items = await listMerchantAttention(db, admin());
    const mine = new Map(
      items
        .filter((item) => item.merchantSlug.startsWith(TAG))
        .map((item) => [item.merchantSlug.slice(TAG.length + 1), item]),
    );
    expect(mine.has("fresh")).toBe(false);
    expect(mine.has("partial")).toBe(false);
    expect(mine.has("inactive")).toBe(false);
    // Son başarılı 3 gün önce: hem başarısız hem bayat (önem sırasıyla).
    expect(mine.get("failed")?.states).toEqual(["failed", "stale"]);
    expect(mine.get("failed")?.failuresSinceSuccess).toBe(2);
    expect(mine.get("never")?.states).toEqual(["never_ran"]);
    expect(mine.get("stale")?.states).toEqual(["stale"]);
    expect(mine.get("stuck")?.states).toEqual(["stuck"]);
    expect(mine.get("shopify")?.states).toEqual(["currency_unverified"]);
  });

  it("önem sırası: takılı → başarısız → para birimi → hiç toplanmadı → bayat", async () => {
    const items = (await listMerchantAttention(db, admin())).filter((item) =>
      item.merchantSlug.startsWith(TAG),
    );
    expect(items.map((item) => item.states[0])).toEqual([
      "stuck",
      "failed",
      "currency_unverified",
      "never_ran",
      "stale",
    ]);
  });

  it("genel bakış dikkat listesini kullanır ve moderatöre de açıktır (görünürlük değişmedi)", async () => {
    const overview = await getAdminOverview(db, moderator());
    const slugs = overview.ingest.attention.map((item) => item.merchantSlug);
    expect(slugs).toContain(`${TAG}-failed`);
    expect(slugs).not.toContain(`${TAG}-inactive`);
  });
});

describe("maliyet doğruluğu", () => {
  it("önbellek dışı ama maliyeti 0 olan çağrı 'fiyatlanmamış' sayılır; önbellek isabeti sayılmaz", async () => {
    const before = await getAdminOverview(db, admin());
    await withOwnerClient(async (client) => {
      const res = await client.query(
        `INSERT INTO api_usage (operation, units, cost_micros, cache_hit)
         VALUES ('visual_search', 120, 0, false),
                ('visual_search', 80, 0, false),
                ('visual_search', 50, 0, true),
                ('visual_search', 40, 7000, false)
         RETURNING id`,
      );
      usageIds.push(...res.rows.map((row) => Number(row.id)));
    });
    const after = await getAdminOverview(db, admin());
    const delta = (key: "unpricedCalls" | "costMicros" | "units" | "calls" | "cacheHits") =>
      after.apiUsage.last24h[key] - before.apiUsage.last24h[key];
    expect(delta("unpricedCalls")).toBe(2);
    expect(delta("costMicros")).toBe(7000);
    expect(delta("units")).toBe(290);
    expect(delta("calls")).toBe(4);
    expect(delta("cacheHits")).toBe(1);
  });
});

describe("boru hattı kanıtı", () => {
  it("her aşama okunur (zaman aşımı yok); toplama kanıtı en yeni başarılı/kısmi koşudur", async () => {
    const evidence = await getPipelineEvidence(db, moderator());
    for (const stage of ["collect", "resolve", "prices", "enrich", "edges", "link"] as const) {
      expect(evidence[stage]).not.toBeNull();
    }
    expect(evidence.collect?.stuckRuns).toBeGreaterThanOrEqual(1);
    const lastGood = evidence.collect?.lastGoodAt?.getTime() ?? 0;
    expect(Date.now() - lastGood).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it("yönetim yetkisi olmayan rol kanıtı okuyamaz", async () => {
    await expect(
      getPipelineEvidence(db, { userId: users.admin?.id as number, role: "user" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });
});

describe("denetim kaydı", () => {
  beforeAll(async () => {
    await withOwnerClient(async (client) => {
      const insert = (
        actorKey: "admin" | "moderator",
        action: string,
        type: string,
        id: string,
        reason: string | null,
      ) =>
        client.query(
          `INSERT INTO admin_audit_event (actor_user_id, actor_role, action, target_type, target_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [users[actorKey]?.id, actorKey, action, type, id, reason],
        );
      await insert(
        "admin",
        "merchant.deactivate",
        "merchant",
        String(merchants.fresh),
        "feed bozuk",
      );
      await insert("admin", "users.view", "app_user", String(users.moderator?.id), null);
      await insert("moderator", "security.access_denied", "capability", "audit.read", null);
      await insert("admin", "merchant.activate", "merchant", "999999999", null);
    });
  });

  it("gerekçe döner; hedefler okunur etikete ve yönetim sayfasına çözülür, kişisel veri yok", async () => {
    const page = await listAdminEvents(db, admin(), { actorUserId: users.admin?.id });
    const byAction = new Map(page.rows.map((row) => [`${row.action}:${row.targetId}`, row]));

    const merchantRow = byAction.get(`merchant.deactivate:${merchants.fresh}`);
    expect(merchantRow?.reason).toBe("feed bozuk");
    expect(merchantRow?.target).toEqual({
      label: `${TAG} fresh`,
      href: `/yonetim/magazalar/${TAG}-fresh`,
    });

    const userRow = byAction.get(`users.view:${users.moderator?.id}`);
    expect(userRow?.target).toEqual({
      label: `hesap #${users.moderator?.id}`,
      href: `/yonetim/kullanicilar/${users.moderator?.publicId}`,
    });
    expect(JSON.stringify(userRow?.target)).not.toContain("@");

    // Silinmiş/var olmayan hedef: bağlantı yok.
    expect(byAction.get("merchant.activate:999999999")?.target.href).toBeNull();
  });

  it("aktör ve hedef filtresi", async () => {
    const byModerator = await listAdminEvents(db, admin(), { actorUserId: users.moderator?.id });
    expect(byModerator.rows.map((row) => row.action)).toEqual(["security.access_denied"]);
    expect(byModerator.rows[0]?.target).toEqual({ label: "yetenek audit.read", href: null });

    const byTarget = await listAdminEvents(db, admin(), {
      targetType: "merchant",
      targetId: String(merchants.fresh),
    });
    expect(byTarget.rows.map((row) => row.action)).toEqual(["merchant.deactivate"]);
  });

  it("moderatör denetim kaydını okuyamaz (sınır değişmedi)", async () => {
    await expect(listAdminEvents(db, moderator())).rejects.toBeInstanceOf(AdminForbiddenError);
  });
});
