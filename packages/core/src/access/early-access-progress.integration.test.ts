/**
 * Erken erisim sayaci - gercek Postgres (karar 0065). Gosterilen sayi =
 * platform disi sayi + gercek `early_access` kayitlari; yeni kayit +1, tekrar
 * okuma/tekrar kayit sayiyi degistirmez; guncelleme yalnizca yoneticiden,
 * gerekceyle ve denetim kaydiyla; uygulama rolu satir ekleyemez/silemez.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminForbiddenError } from "../admin/capabilities.ts";
import {
  EarlyAccessCounterValidationError,
  getEarlyAccessCounterAdmin,
  setOffPlatformCount,
} from "../admin/early-access-counter.ts";
import { getRedis } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { ensureEarlyAccess } from "./early-access.ts";
import { getEarlyAccessProgress } from "./early-access-progress.ts";
import {
  EARLY_ACCESS_PROGRESS_CACHE_KEY,
  EARLY_ACCESS_PROGRESS_TTL_SECONDS,
  getCachedEarlyAccessProgress,
  invalidateEarlyAccessProgressCache,
} from "./early-access-progress-cache.ts";

const suffix = Date.now();
const EMAILS = [`eap-admin-${suffix}@example.test`, `eap-user-${suffix}@example.test`];

async function userId(email: string, role: string): Promise<number> {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
      [email, role],
    );
    return Number(res.rows[0].id);
  });
}

async function ownerCount(): Promise<number> {
  return withOwnerClient(async (client) => {
    const res = await client.query("SELECT count(*)::int AS n FROM early_access");
    return res.rows[0].n;
  });
}

const throwingDb = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("veritabanina gidilmemeliydi");
    },
  },
) as unknown as Database;

describe("erken erisim sayaci - entegrasyon", () => {
  let db: Database;
  let adminId: number;
  let memberId: number;
  let originalOffPlatform = 0;

  beforeAll(async () => {
    db = getTestDb();
    originalOffPlatform = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT off_platform_count FROM early_access_counter");
      return Number(res.rows[0].off_platform_count);
    });
    await withOwnerClient((client) =>
      client.query("UPDATE early_access_counter SET off_platform_count = 78 WHERE id = 1"),
    );
    adminId = await userId(EMAILS[0] as string, "admin");
    memberId = await userId(EMAILS[1] as string, "user");
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM app_user WHERE email = ANY($1)", [EMAILS]);
      await client.query("UPDATE early_access_counter SET off_platform_count = $1 WHERE id = 1", [
        originalOffPlatform,
      ]);
    });
  });

  it("gösterilen sayı = platform dışı 78 + gerçek kayıtlar", async () => {
    const progress = await getEarlyAccessProgress(db);
    expect(progress.count).toBe(78 + (await ownerCount()));
    expect(progress.target).toBe(5000);
  });

  it("gerçek kayıt listeye girer, sayı bu satırı yansıtır; tekrar kayıt ve tekrar okuma değiştirmez", async () => {
    // Başka test dosyaları aynı tabloya eş zamanlı yazabilir: global farkı değil,
    // kendi satırımızı ve "gösterilen = 78 + COUNT" tutarlılığını doğrularız
    // (tam +1 etkisi birim testte).
    const mine = () =>
      withOwnerClient(async (client) => {
        const res = await client.query(
          "SELECT count(*)::int AS n FROM early_access WHERE user_id = $1",
          [memberId],
        );
        return res.rows[0].n as number;
      });
    const consistent = async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const [progress, total] = [await getEarlyAccessProgress(db), await ownerCount()];
        const again = await ownerCount();
        if (total === again && progress.count === 78 + total) return true;
      }
      return false;
    };
    expect(await mine()).toBe(0);
    await ensureEarlyAccess(db, memberId);
    expect(await mine()).toBe(1);
    expect(await consistent()).toBe(true);
    // Tekrar kayıt ve yenileme ikinci satır üretmez.
    await ensureEarlyAccess(db, memberId);
    await getEarlyAccessProgress(db);
    expect(await mine()).toBe(1);
  });

  it("yönetici platform dışı sayıyı gerekçeyle günceller ve denetim kaydı düşer", async () => {
    const actor = { userId: adminId, role: "admin" as const };
    const result = await setOffPlatformCount(db, actor, "90", "E-postayla gelen 12 başvuru");
    expect(result).toEqual({ before: 78, after: 90 });
    const view = await getEarlyAccessCounterAdmin(db, actor);
    expect(view.offPlatformCount).toBe(90);
    expect(view.count).toBe(90 + (await ownerCount()));

    const audit = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT before, after, reason FROM admin_audit_event
          WHERE action = 'early_access.counter_set' AND actor_user_id = $1`,
        [adminId],
      );
      return res.rows;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].before).toEqual({ offPlatformCount: 78 });
    expect(audit[0].after).toEqual({ offPlatformCount: 90 });
    expect(audit[0].reason).toBe("E-postayla gelen 12 başvuru");
  });

  it("geçersiz değer ve gerekçesiz istek sayıyı değiştirmez", async () => {
    const actor = { userId: adminId, role: "admin" as const };
    await expect(setOffPlatformCount(db, actor, "-3", "Geçerli gerekçe")).rejects.toThrow(
      EarlyAccessCounterValidationError,
    );
    await expect(setOffPlatformCount(db, actor, "95", "")).rejects.toThrow(
      EarlyAccessCounterValidationError,
    );
    expect((await getEarlyAccessCounterAdmin(db, actor)).offPlatformCount).toBe(90);
  });

  it("moderatör ve normal kullanıcı güncelleyemez", async () => {
    for (const role of ["moderator", "user"] as const) {
      await expect(
        setOffPlatformCount(db, { userId: memberId, role }, "100", "Geçerli gerekçe"),
      ).rejects.toThrow(AdminForbiddenError);
    }
  });

  it("uygulama rolü sayaç satırını ekleyemez, silemez; yalnızca günceller", async () => {
    await expect(
      db.execute(sql`INSERT INTO early_access_counter (id, off_platform_count) VALUES (2, 5)`),
    ).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM early_access_counter`)).rejects.toThrow();
    await expect(
      db.execute(sql`UPDATE early_access_counter SET off_platform_count = 91 WHERE id = 1`),
    ).resolves.toBeDefined();
  });

  describe("anonim ana sayfa önbelleği (Redis, karar 0043)", () => {
    it("ilk okuma hesaplar ve TTL ile saklar; ikinci okuma veritabanına gitmez", async () => {
      await withOwnerClient((client) =>
        client.query("UPDATE early_access_counter SET off_platform_count = 78 WHERE id = 1"),
      );
      await invalidateEarlyAccessProgressCache();
      const first = await getCachedEarlyAccessProgress(() => db);
      expect(first?.target).toBe(5000);
      expect(first?.count).toBeGreaterThanOrEqual(78);
      const ttl = await getRedis().ttl(EARLY_ACCESS_PROGRESS_CACHE_KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(EARLY_ACCESS_PROGRESS_TTL_SECONDS);
      expect(await getCachedEarlyAccessProgress(() => throwingDb)).toEqual(first);
    });

    it("geçersiz kılma sonrası yeni sayı okunur", async () => {
      await withOwnerClient((client) =>
        client.query("UPDATE early_access_counter SET off_platform_count = 120 WHERE id = 1"),
      );
      const stale = await getCachedEarlyAccessProgress(() => db);
      expect(stale?.count).toBeLessThan(120);
      await invalidateEarlyAccessProgressCache();
      const fresh = await getCachedEarlyAccessProgress(() => db);
      expect(fresh?.count).toBeGreaterThanOrEqual(120);
    });

    it("bozuk önbellek kaydı yok sayılır ve yeniden hesaplanır", async () => {
      await getRedis().set(EARLY_ACCESS_PROGRESS_CACHE_KEY, "{bozuk", "EX", 30);
      const progress = await getCachedEarlyAccessProgress(() => db);
      expect(progress?.count).toBeGreaterThanOrEqual(120);
      await invalidateEarlyAccessProgressCache();
    });
  });
});
