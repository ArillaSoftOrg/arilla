/**
 * Faz D yönetim özellikleri (karar 0086) — gerçek Postgres. Değişiklik ve
 * denetim satırı aynı işlemde: denetim yazılamazsa değişiklik geri alınır;
 * beklenen durum tutmazsa `conflict`; görünürlük public kuralla aynı.
 * Tohum satırları benzersiz etiket taşır ve sonunda silinir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { MIN_PUBLIC_TREND_PRODUCTS } from "../trends/types.ts";
import type { AdminActor } from "./capabilities.ts";
import { EARLY_ACCESS_PAGE_SIZE, listEarlyAccessApplications } from "./early-access.ts";
import { listInboxMessages, setInboxMessagePriority, setInboxMessageStatus } from "./messages.ts";
import { listTrendsForAdmin, moveTrend, setTrendFeatured, setTrendStatus } from "./trends-admin.ts";

describe("yönetim özellikleri - entegrasyon (karar 0086)", () => {
  let db: Database;
  const tag = `mgd${Date.now().toString(36)}`;
  const secretBody = `GIZLI-MESAJ-${tag}`;
  const secretEmail = `${tag}-gonderen@test.local`;
  let admin: AdminActor;
  /** Var olmayan kullanıcı: denetim satırının yabancı anahtarı kırılır. */
  const ghost: AdminActor = { userId: 9_000_000_000_000, role: "admin" };
  const userIds: number[] = [];
  const trendIds: number[] = [];
  let feedbackId = 0;
  const productIds: number[] = [];
  const applicants: string[] = [];

  async function trendRow(id: number) {
    return withOwnerClient(async (client) => {
      const res = await client.query(
        "SELECT status, featured, sort_order FROM trend WHERE id = $1",
        [id],
      );
      return res.rows[0] as { status: string; featured: boolean; sort_order: number };
    });
  }

  async function audits(targetType: string, targetId: number) {
    return withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT action, actor_user_id, before, after, reason FROM admin_audit_event
          WHERE target_type = $1 AND target_id = $2 ORDER BY id`,
        [targetType, String(targetId)],
      );
      return res.rows as {
        action: string;
        actor_user_id: string;
        before: unknown;
        after: unknown;
        reason: string | null;
      }[];
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const a = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`${tag}-admin@test.local`],
      );
      admin = { userId: Number(a.rows[0].id), role: "admin" };
      userIds.push(admin.userId);
      // Sıranın en sonunda, birbirine komşu üç taslak trend.
      for (const [i, order] of [1_900_000_000, 1_900_000_001, 1_900_000_001].entries()) {
        const t = await client.query(
          `INSERT INTO trend (slug, title, description, category, status, sort_order)
           VALUES ($1, $2, 'Yönetim testi', 'genel', 'draft', $3) RETURNING id`,
          [`${tag}-trend-${i}`, `Yönetim trendi ${i}`, order],
        );
        trendIds.push(Number(t.rows[0].id));
      }
      // İlk trende eşik kadar gösterilebilir + bir gösterilemez ürün.
      for (let i = 0; i <= MIN_PUBLIC_TREND_PRODUCTS; i++) {
        const showable = i < MIN_PUBLIC_TREND_PRODUCTS;
        const p = await client.query(
          `INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count)
           VALUES ($1, 'Yönetim ürünü', $2, 1000, $3) RETURNING id`,
          [`${tag}-urun-${i}`, showable ? "https://example.test/g.jpg" : null, showable ? 1 : 0],
        );
        productIds.push(Number(p.rows[0].id));
        await client.query(
          "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1, $2, $3)",
          [trendIds[0], p.rows[0].id, i],
        );
      }
      const f = await client.query(
        `INSERT INTO feedback (kind, name, email, category, title, message, source)
         VALUES ('contact', 'Gönderen', $1, 'general', $2, $3, 'public') RETURNING id`,
        [secretEmail, `Konu ${tag}`, secretBody],
      );
      feedbackId = Number(f.rows[0].id);
      // Aynı mikrosaniyede çok sayıda başvuru: imleç eşit zamanda satır atlamamalı.
      for (let i = 0; i < EARLY_ACCESS_PAGE_SIZE + 2; i++) {
        const u = await client.query(
          "INSERT INTO app_user (email) VALUES ($1) RETURNING id, public_id",
          [`${tag}-ea-${i}@test.local`],
        );
        userIds.push(Number(u.rows[0].id));
        applicants.push(String(u.rows[0].public_id));
        await client.query(
          "INSERT INTO early_access (user_id, created_at) VALUES ($1, '2099-01-01T00:00:00.123456Z')",
          [u.rows[0].id],
        );
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `DELETE FROM admin_audit_event
          WHERE (target_type = 'trend' AND target_id = ANY($1))
             OR (target_type = 'feedback' AND target_id = $2)
             OR actor_user_id = $3`,
        [trendIds.map(String), String(feedbackId), admin.userId],
      );
      await client.query("DELETE FROM trend WHERE id = ANY($1)", [trendIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
      await client.query("DELETE FROM feedback WHERE id = $1", [feedbackId]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
    });
  });

  it("trend listesi: bağlı/gösterilebilir ürün ve görünürlük public kuralla aynı", async () => {
    const list = await listTrendsForAdmin(db, admin, { status: "draft" });
    const row = list.rows.find((r) => r.id === trendIds[0]);
    expect(row).toMatchObject({
      linkedProducts: MIN_PUBLIC_TREND_PRODUCTS + 1,
      showableProducts: MIN_PUBLIC_TREND_PRODUCTS,
      visible: false, // taslak
      windowState: "none",
    });
  });

  it("yayınla: değişiklik ve gerekçeli denetim tek işlemde; yayında + eşik = görünür", async () => {
    const id = trendIds[0] as number;
    const result = await setTrendStatus(db, admin, {
      trendId: id,
      next: "published",
      expectedStatus: "draft",
      reason: "  Kampanya başlıyor  ",
    });
    expect(result).toEqual({ status: "updated" });
    expect((await trendRow(id)).status).toBe("published");
    const rows = await audits("trend", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "trends.publish",
      actor_user_id: String(admin.userId),
      before: { status: "draft" },
      after: { status: "published" },
      reason: "Kampanya başlıyor",
    });
    const list = await listTrendsForAdmin(db, admin, { status: "published" });
    expect(list.rows.find((r) => r.id === id)?.visible).toBe(true);
  });

  it("beklenen durum tutmazsa conflict; yazım ve denetim yok", async () => {
    const id = trendIds[0] as number;
    const result = await setTrendStatus(db, admin, {
      trendId: id,
      next: "published",
      expectedStatus: "draft", // gerçekte yayında
      reason: "eski sayfadan deneme",
    });
    expect(result).toEqual({ status: "conflict" });
    expect(await audits("trend", id)).toHaveLength(1);
  });

  it("denetim yazılamazsa değişiklik geri alınır (atomik)", async () => {
    const id = trendIds[0] as number;
    await expect(
      setTrendStatus(db, ghost, {
        trendId: id,
        next: "draft",
        expectedStatus: "published",
        reason: "geri alma denemesi",
      }),
    ).rejects.toThrow();
    expect((await trendRow(id)).status).toBe("published");
    await expect(
      setTrendFeatured(db, ghost, { trendId: id, featured: true, reason: "geri alma denemesi" }),
    ).rejects.toThrow();
    expect((await trendRow(id)).featured).toBe(false);
    expect(await audits("trend", id)).toHaveLength(1);
  });

  it("öne çıkarma: değişmeyen değer denetim üretmez", async () => {
    const id = trendIds[1] as number;
    expect(
      await setTrendFeatured(db, admin, { trendId: id, featured: true, reason: "vitrin" }),
    ).toEqual({ status: "updated" });
    expect(
      await setTrendFeatured(db, admin, { trendId: id, featured: true, reason: "vitrin tekrar" }),
    ).toEqual({ status: "unchanged" });
    const rows = await audits("trend", id);
    expect(rows.map((r) => r.action)).toEqual(["trends.feature"]);
    expect((await trendRow(id)).featured).toBe(true);
  });

  it("sıra: eşit değerde de ayrışır, komşuyla yer değiştirir; olmayan trend not_found", async () => {
    const [, second, third] = trendIds as [number, number, number];
    // İkisi de 1_900_000_001: kimlik sırasıyla üçüncü sonra gelir; yukarı taşı.
    expect(
      await moveTrend(db, admin, { trendId: third, direction: "up", reason: "öne al" }),
    ).toEqual({ status: "updated" });
    const list = await listTrendsForAdmin(db, admin);
    const order = list.rows.filter((r) => trendIds.includes(r.id)).map((r) => r.id);
    expect(order).toEqual([trendIds[0], third, second]);
    const rows = await audits("trend", third);
    expect(rows.at(-1)).toMatchObject({ action: "trends.reorder", reason: "öne al" });
    expect(
      await moveTrend(db, admin, { trendId: 2 ** 40, direction: "up", reason: "olmayan trend" }),
    ).toEqual({ status: "not_found" });
  });

  it("gelen kutusu: izinli geçiş, filtre, çakışma; denetimde içerik/e-posta yok", async () => {
    expect(
      await setInboxMessageStatus(db, admin, {
        messageId: feedbackId,
        next: "reviewing",
        expectedStatus: "new",
      }),
    ).toEqual({ status: "updated" });
    expect(
      await setInboxMessageStatus(db, admin, {
        messageId: feedbackId,
        next: "planned",
        expectedStatus: "new",
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await setInboxMessagePriority(db, admin, { messageId: feedbackId, priority: "high" }),
    ).toEqual({ status: "updated" });
    expect(
      await setInboxMessagePriority(db, admin, { messageId: feedbackId, priority: "high" }),
    ).toEqual({ status: "unchanged" });

    const filtered = await listInboxMessages(db, admin, { status: "reviewing", priority: "high" });
    expect(filtered.rows.some((r) => r.id === feedbackId)).toBe(true);
    const none = await listInboxMessages(db, admin, { priority: "none", status: "reviewing" });
    expect(none.rows.some((r) => r.id === feedbackId)).toBe(false);

    const rows = await audits("feedback", feedbackId);
    expect(rows.map((r) => r.action)).toEqual([
      "messages.status_change",
      "messages.priority_change",
    ]);
    expect(rows[0]).toMatchObject({ before: { status: "new" }, after: { status: "reviewing" } });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain(secretEmail);
  });

  it("gelen kutusu: denetim yazılamazsa durum geri alınır", async () => {
    await expect(
      setInboxMessageStatus(db, ghost, {
        messageId: feedbackId,
        next: "resolved",
        expectedStatus: "reviewing",
      }),
    ).rejects.toThrow();
    const row = await withOwnerClient((client) =>
      client.query("SELECT status FROM feedback WHERE id = $1", [feedbackId]),
    );
    expect(row.rows[0].status).toBe("reviewing");
  });

  it("erken erişim: imleçle tüm başvurular tam bir kez; e-posta yok", async () => {
    const seen: string[] = [];
    let cursor: number | null | undefined;
    for (let pageNo = 0; pageNo < 3; pageNo++) {
      const page = await listEarlyAccessApplications(db, admin, { cursor });
      expect(page.rows.length).toBeLessThanOrEqual(EARLY_ACCESS_PAGE_SIZE);
      expect(JSON.stringify(page)).not.toContain("@");
      seen.push(...page.rows.map((r) => r.publicId).filter((id) => applicants.includes(id)));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual([...applicants].sort());
  });
});
