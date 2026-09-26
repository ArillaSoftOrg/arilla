import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { AUDIT_PAGE_SIZE_MAX, listAdminEvents, maskEmail, recordAdminEvent } from "./audit.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import { getAdminOverview } from "./dashboard.ts";

describe("denetim kaydı - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const targetId = `audit-test-${suffix}`;
  let admin: AdminActor;
  let moderator: AdminActor;

  beforeAll(async () => {
    db = getTestDb();
    [admin, moderator] = await withOwnerClient(async (client) => {
      const a = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`audit-admin-${suffix}@test.local`],
      );
      const m = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`audit-mod-${suffix}@test.local`],
      );
      return [
        { userId: Number(a.rows[0].id), role: "admin" as const },
        { userId: Number(m.rows[0].id), role: "moderator" as const },
      ];
    });
    for (let i = 0; i < 5; i++) {
      await recordAdminEvent(db, {
        actor: admin,
        action: "lexicon.update",
        targetType: "lexicon",
        targetId,
        before: { weight: i },
        after: { weight: i + 1 },
      });
    }
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
    });
  });

  it("uygulama rolü denetim kaydını değiştiremez ve silemez (append-only, 42501)", async () => {
    for (const statement of [
      sql`UPDATE admin_audit_event SET reason = 'x' WHERE target_id = ${targetId}`,
      sql`DELETE FROM admin_audit_event WHERE target_id = ${targetId}`,
    ]) {
      await expect(db.execute(statement)).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "42501" }),
      });
    }
  });

  it("listAdminEvents: yeniden eskiye, imleçle sayfalanır, satır tekrarlanmaz", async () => {
    const first = await listAdminEvents(db, admin, { targetId, pageSize: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextBeforeId).not.toBeNull();
    const second = await listAdminEvents(db, admin, {
      targetId,
      pageSize: 2,
      beforeId: first.nextBeforeId ?? undefined,
    });
    const third = await listAdminEvents(db, admin, {
      targetId,
      pageSize: 2,
      beforeId: second.nextBeforeId ?? undefined,
    });
    expect(third.rows).toHaveLength(1);
    expect(third.nextBeforeId).toBeNull();

    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(first.rows[0]?.after).toEqual({ weight: 5 });
    expect(first.rows[0]?.actorLabel).toBe(maskEmail(`audit-admin-${suffix}@test.local`));
  });

  it("sayfa boyutu üst sınırı uygulanır", async () => {
    const page = await listAdminEvents(db, admin, { pageSize: 10_000 });
    expect(page.rows.length).toBeLessThanOrEqual(AUDIT_PAGE_SIZE_MAX);
  });

  it("moderator denetim kaydını okuyamaz", async () => {
    await expect(listAdminEvents(db, moderator, { targetId })).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });

  it("getAdminOverview: moderator okuyabilir, sayılar sayıdır; user okuyamaz", async () => {
    const overview = await getAdminOverview(db, moderator);
    expect(typeof overview.pendingMatches).toBe("number");
    expect(typeof overview.merchants.total).toBe("number");
    expect(overview.merchants.active).toBeLessThanOrEqual(overview.merchants.total);
    expect(overview.newUsers7d).toBeGreaterThanOrEqual(2);

    await expect(
      getAdminOverview(db, { userId: moderator.userId, role: "user" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });
});

describe("maskEmail", () => {
  it("yerel kısmı gizler, alan adını bırakır", () => {
    expect(maskEmail("ayse@gmail.com")).toBe("a***@gmail.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("bozuk")).toBe("***");
  });
});
