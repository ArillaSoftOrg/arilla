import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  createTrackingLink,
  getTrackingLink,
  getTrackingLinkStats,
  listTrackingLinks,
  resolveStatsRange,
  setTrackingLinkActive,
  updateTrackingLink,
} from "./admin.ts";
import { TrackingLinkValidationError, targetPolicyFromEnv } from "./policy.ts";
import {
  type CacheClient,
  CLICK_RATE_LIMIT_PER_MINUTE,
  cacheKey,
  invalidateTrackingLinkCache,
  recordTrackingClick,
  resolveTrackingLink,
  withinClickRateLimit,
} from "./redirect.ts";

const policy = targetPolicyFromEnv({ APP_URL: "https://manicepte.com" });

/** Bellek içi Redis yerine: TTL değerlerini de kaydeder. */
class MemoryCache implements CacheClient {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  failing = false;
  async get(key: string) {
    if (this.failing) throw new Error("redis down");
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _mode: "EX", seconds: number) {
    if (this.failing) throw new Error("redis down");
    this.store.set(key, value);
    this.ttls.set(key, seconds);
  }
  async del(key: string) {
    if (this.failing) throw new Error("redis down");
    this.store.delete(key);
  }
}

describe("takip bağlantıları - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now().toString(36);
  let admin: AdminActor;
  let moderator: AdminActor;
  const slugs: string[] = [];
  const slug = (name: string) => {
    const value = `t${suffix}${name}`.slice(0, 40);
    slugs.push(value);
    return value;
  };
  const base = { name: "Instagram bio", targetUrl: "/", source: "instagram", campaign: "yaz" };

  beforeAll(async () => {
    db = getTestDb();
    [admin, moderator] = await withOwnerClient(async (client) => {
      const a = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`links-admin-${suffix}@test.local`],
      );
      const m = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`links-mod-${suffix}@test.local`],
      );
      return [
        { userId: Number(a.rows[0].id), role: "admin" as const },
        { userId: Number(m.rows[0].id), role: "moderator" as const },
      ];
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM tracking_link_click_hour WHERE link_id IN (SELECT id FROM tracking_link WHERE slug = ANY($1))",
        [slugs],
      );
      await client.query("DELETE FROM tracking_link WHERE slug = ANY($1)", [slugs]);
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
    });
  });

  describe("yetki", () => {
    it("moderatör hiçbir okuma ya da yazma yapamaz", async () => {
      const s = slug("yetki");
      await expect(
        createTrackingLink(db, moderator, { ...base, slug: s }, policy),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(
        listTrackingLinks(db, moderator, { range: resolveStatsRange({}) }),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(getTrackingLink(db, moderator, 1)).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(
        updateTrackingLink(db, moderator, { ...base, id: 1 }, policy),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(
        setTrackingLinkActive(db, moderator, { id: 1, active: false }),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(
        getTrackingLinkStats(db, moderator, { linkId: 1, range: resolveStatsRange({}) }),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
      const rows = await db.execute(sql`SELECT 1 FROM tracking_link WHERE slug = ${s}`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe("oluşturma, düzenleme, pasife alma", () => {
    it("oluşturur, denetime yazar ve slug'ı değiştirmeden düzenler", async () => {
      const s = slug("olustur");
      const created = await createTrackingLink(
        db,
        admin,
        { ...base, slug: s.toUpperCase() },
        policy,
      );
      expect(created.status).toBe("created");
      const id = (created as { id: number }).id;

      const row = await getTrackingLink(db, admin, id);
      expect(row).toMatchObject({
        slug: s,
        name: "Instagram bio",
        source: "instagram",
        isActive: true,
      });

      const updated = await updateTrackingLink(
        db,
        admin,
        { ...base, id, name: "Yeni ad", targetUrl: "/trendler/yaz?x=1", campaign: null },
        policy,
      );
      expect(updated.status).toBe("updated");
      expect(await getTrackingLink(db, admin, id)).toMatchObject({
        slug: s,
        name: "Yeni ad",
        targetUrl: "/trendler/yaz?x=1",
        campaign: null,
      });

      const same = await updateTrackingLink(
        db,
        admin,
        { ...base, id, name: "Yeni ad", targetUrl: "/trendler/yaz?x=1", campaign: null },
        policy,
      );
      expect(same.status).toBe("unchanged");

      const events = await db.execute<{ action: string; before: unknown; after: unknown }>(
        sql`SELECT action, before, after FROM admin_audit_event
             WHERE target_type = 'tracking_link' AND target_id = ${String(id)} ORDER BY id`,
      );
      expect(events.rows.map((r) => r.action)).toEqual(["links.create", "links.update"]);
      // Hedefin sorgu dizgesi denetime yazılmaz.
      expect(JSON.stringify(events.rows)).not.toContain("x=1");
    });

    it("aynı slug ikinci kez alınamaz (büyük/küçük harf duyarsız)", async () => {
      const s = slug("tekrar");
      expect((await createTrackingLink(db, admin, { ...base, slug: s }, policy)).status).toBe(
        "created",
      );
      expect(
        (await createTrackingLink(db, admin, { ...base, slug: s.toUpperCase() }, policy)).status,
      ).toBe("slug_taken");
    });

    it("eşzamanlı iki oluşturmadan yalnızca biri kazanır", async () => {
      const s = slug("yaris");
      const results = await Promise.all([
        createTrackingLink(db, admin, { ...base, slug: s }, policy),
        createTrackingLink(db, admin, { ...base, slug: s }, policy),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["created", "slug_taken"]);
    });

    it("rezerve slug ve güvensiz hedef hiçbir satır yazmaz", async () => {
      const before = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM tracking_link`);
      await expect(
        createTrackingLink(db, admin, { ...base, slug: "yonetim" }, policy),
      ).rejects.toBeInstanceOf(TrackingLinkValidationError);
      await expect(
        createTrackingLink(
          db,
          admin,
          { ...base, slug: slug("kotu"), targetUrl: "https://evil.example/" },
          policy,
        ),
      ).rejects.toBeInstanceOf(TrackingLinkValidationError);
      const after = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM tracking_link`);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });

    it("pasife alır ve geri açar; aynı değer 'unchanged'", async () => {
      const s = slug("pasif");
      const { id } = (await createTrackingLink(db, admin, { ...base, slug: s }, policy)) as {
        id: number;
      };
      expect((await setTrackingLinkActive(db, admin, { id, active: false })).status).toBe(
        "updated",
      );
      expect((await setTrackingLinkActive(db, admin, { id, active: false })).status).toBe(
        "unchanged",
      );
      expect((await setTrackingLinkActive(db, admin, { id, active: true })).status).toBe("updated");
      expect(
        (await setTrackingLinkActive(db, admin, { id: 9_999_999_999, active: true })).status,
      ).toBe("not_found");
    });

    it("eski sürüm belirteciyle düzenleme çakışma döner", async () => {
      const s = slug("cakisma");
      const { id } = (await createTrackingLink(db, admin, { ...base, slug: s }, policy)) as {
        id: number;
      };
      const stale = (await getTrackingLink(db, admin, id))?.updatedAt.toISOString();
      await updateTrackingLink(db, admin, { ...base, id, name: "Birinci" }, policy);
      const result = await updateTrackingLink(
        db,
        admin,
        { ...base, id, name: "İkinci", expectedUpdatedAt: stale },
        policy,
      );
      expect(result.status).toBe("conflict");
      expect((await getTrackingLink(db, admin, id))?.name).toBe("Birinci");
    });

    it("uygulama rolü bağlantıyı SİLEMEZ (pasife alınır)", async () => {
      const s = slug("silinmez");
      await createTrackingLink(db, admin, { ...base, slug: s }, policy);
      await expect(db.execute(sql`DELETE FROM tracking_link WHERE slug = ${s}`)).rejects.toThrow();
    });

    it("veritabanı kısıtları kodu atlatan yazımı da reddeder", async () => {
      for (const [slugValue, target] of [
        ["Büyük", "/"],
        ["ok-slug-x", "javascript:alert(1)"],
        ["ok-slug-y", "//evil.example"],
        ["ok-slug-z", "http://manicepte.com/"],
      ] as const) {
        await expect(
          db.execute(
            sql`INSERT INTO tracking_link (name, slug, target_url) VALUES ('x', ${slugValue}, ${target})`,
          ),
        ).rejects.toThrow();
      }
    });
  });

  describe("yönlendirme çözümü ve önbellek", () => {
    it("çözer, UTM ekler, önbelleğe yazar; yoksa kısa süreli yok kaydı tutar", async () => {
      const s = slug("coz");
      await createTrackingLink(db, admin, { ...base, slug: s, targetUrl: "/trendler/yaz" }, policy);
      const cache = new MemoryCache();

      const first = await resolveTrackingLink(db, s, policy, cache);
      const url = new URL(first?.location ?? "");
      expect(url.origin + url.pathname).toBe("https://manicepte.com/trendler/yaz");
      expect(url.searchParams.get("utm_source")).toBe("instagram");
      expect(url.searchParams.get("utm_campaign")).toBe("yaz");
      expect(cache.ttls.get(cacheKey(s))).toBe(60);

      // İkinci çözüm veritabanı olmadan önbellekten gelir.
      const fromCache = await resolveTrackingLink({} as Database, s, policy, cache);
      expect(fromCache?.location).toBe(first?.location);

      const missing = `yok${suffix}`;
      expect(await resolveTrackingLink(db, missing, policy, cache)).toBeNull();
      expect(cache.store.get(cacheKey(missing))).toBe("-");
      expect(cache.ttls.get(cacheKey(missing))).toBe(30);
    });

    it("şekle uymayan slug veritabanına ve Redis'e hiç gitmez", async () => {
      const exploding = {
        get() {
          throw new Error("Redis'e gidilmemeliydi");
        },
      } as unknown as CacheClient;
      const noDb = {} as Database;
      for (const probe of ["wp-login.php", "..%2f", "a b", "İ", "-x", "a".repeat(41), ""]) {
        expect(await resolveTrackingLink(noDb, probe, policy, exploding)).toBeNull();
      }
    });

    it("pasife alma ve düzenleme önbelleği hemen geçersiz kılar", async () => {
      const s = slug("gecersiz");
      const { id } = (await createTrackingLink(db, admin, { ...base, slug: s }, policy)) as {
        id: number;
      };
      const cache = new MemoryCache();
      expect(await resolveTrackingLink(db, s, policy, cache)).not.toBeNull();
      await setTrackingLinkActive(db, admin, { id, active: false });
      // Yönetim varsayılan (gerçek) Redis'i temizler; bu testte aynı davranış açıkça uygulanır.
      await invalidateTrackingLinkCache(s, cache);
      expect(await resolveTrackingLink(db, s, policy, cache)).toBeNull();
    });

    it("pasif bağlantı önbellekte olsa bile yönlendirmez", async () => {
      const s = slug("pasifonb");
      const { id } = (await createTrackingLink(db, admin, { ...base, slug: s }, policy)) as {
        id: number;
      };
      await setTrackingLinkActive(db, admin, { id, active: false });
      const cache = new MemoryCache();
      expect(await resolveTrackingLink(db, s, policy, cache)).toBeNull();
      cache.store.set(
        cacheKey(s),
        JSON.stringify({ id, targetUrl: "/", source: null, campaign: null, isActive: false }),
      );
      expect(await resolveTrackingLink(db, s, policy, cache)).toBeNull();
    });

    it("zehirlenmiş önbellek açık yönlendirme üretmez; bozuk JSON veritabanına düşer", async () => {
      const s = slug("zehir");
      await createTrackingLink(db, admin, { ...base, slug: s, targetUrl: "/trendler/iyi" }, policy);
      const cache = new MemoryCache();
      cache.store.set(
        cacheKey(s),
        JSON.stringify({
          id: 1,
          targetUrl: "https://evil.example/",
          source: null,
          campaign: null,
          isActive: true,
        }),
      );
      expect(await resolveTrackingLink(db, s, policy, cache)).toBeNull();

      cache.store.set(cacheKey(s), "{bozuk json");
      const recovered = await resolveTrackingLink(db, s, policy, cache);
      expect(recovered?.location).toContain("/trendler/iyi");
    });

    it("Redis çökse de yönlendirme veritabanından sürer", async () => {
      const s = slug("redisyok");
      await createTrackingLink(db, admin, { ...base, slug: s }, policy);
      const cache = new MemoryCache();
      cache.failing = true;
      expect((await resolveTrackingLink(db, s, policy, cache))?.location).toContain(
        "utm_source=instagram",
      );
    });
  });

  describe("tıklama sayacı ve istatistik", () => {
    it("eşzamanlı tıklamalar kaybolmadan toplanır ve satıra kişi verisi yazılmaz", async () => {
      const s = slug("sayac");
      const { id } = (await createTrackingLink(db, admin, { ...base, slug: s }, policy)) as {
        id: number;
      };
      await Promise.all(Array.from({ length: 25 }, () => recordTrackingClick(db, id)));

      const rows = await db.execute<{ clicks: number; hour: Date; cols: string[] }>(sql`
        SELECT clicks, hour FROM tracking_link_click_hour WHERE link_id = ${id}`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.clicks).toBe(25);

      const columns = await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'tracking_link_click_hour'
         ORDER BY ordinal_position`);
      expect(columns.rows.map((c) => c.column_name)).toEqual(["link_id", "hour", "clicks"]);
    });

    it("günlük ve saatlik istatistik, boş günler sıfırlı, Istanbul gün sınırıyla", async () => {
      const s = slug("istat");
      const { id } = (await createTrackingLink(db, admin, { ...base, slug: s }, policy)) as {
        id: number;
      };
      // Istanbul = UTC+3. 2026-03-10 22:30 UTC = 2026-03-11 01:30 Istanbul.
      await withOwnerClient((client) =>
        client.query(
          `INSERT INTO tracking_link_click_hour (link_id, hour, clicks) VALUES
             ($1, '2026-03-10T20:00:00Z', 4),
             ($1, '2026-03-10T22:00:00Z', 6),
             ($1, '2026-03-12T09:00:00Z', 5)`,
          [id],
        ),
      );
      const range = resolveStatsRange({ from: "2026-03-10", to: "2026-03-12" });
      const stats = await getTrackingLinkStats(db, admin, { linkId: id, range });
      expect(stats.total).toBe(15);
      // 20:00Z = 23:00 Istanbul (10 Mart); 22:00Z = 01:00 Istanbul (11 Mart).
      expect(stats.daily).toEqual([
        { day: "2026-03-10", clicks: 4 },
        { day: "2026-03-11", clicks: 6 },
        { day: "2026-03-12", clicks: 5 },
      ]);
      expect(stats.peakDay).toEqual({ day: "2026-03-11", clicks: 6 });
      expect(stats.hourly).toHaveLength(72);
      expect(stats.hourly?.find((h) => h.label === "2026-03-10T23:00")?.clicks).toBe(4);
      expect(stats.hourly?.find((h) => h.label === "2026-03-11T01:00")?.clicks).toBe(6);

      // Aralık dışı saat sayılmaz; kısa aralık dışında saatlik görünüm yok.
      const narrow = await getTrackingLinkStats(db, admin, {
        linkId: id,
        range: resolveStatsRange({ from: "2026-03-11", to: "2026-03-11" }),
      });
      expect(narrow.total).toBe(6);
      const wide = await getTrackingLinkStats(db, admin, {
        linkId: id,
        range: resolveStatsRange({ from: "2026-03-01", to: "2026-03-31" }),
      });
      expect(wide.hourly).toBeNull();
      expect(wide.daily).toHaveLength(31);
      expect(wide.total).toBe(15);
    });

    it("listede aralık içi, toplam ve son tıklama doğru; başka bağlantının sayacı karışmaz", async () => {
      const a = slug("lista");
      const b = slug("listb");
      const { id: idA } = (await createTrackingLink(db, admin, { ...base, slug: a }, policy)) as {
        id: number;
      };
      const { id: idB } = (await createTrackingLink(db, admin, { ...base, slug: b }, policy)) as {
        id: number;
      };
      await withOwnerClient((client) =>
        client.query(
          `INSERT INTO tracking_link_click_hour (link_id, hour, clicks) VALUES
             ($1, '2026-01-05T10:00:00Z', 7), ($1, '2026-02-05T10:00:00Z', 3), ($2, '2026-02-05T10:00:00Z', 100)`,
          [idA, idB],
        ),
      );
      const rows = await listTrackingLinks(db, admin, {
        range: resolveStatsRange({ from: "2026-02-01", to: "2026-02-28" }),
      });
      const rowA = rows.find((r) => r.id === idA);
      expect(rowA).toMatchObject({ clicksInRange: 3, clicksTotal: 10 });
      expect(rowA?.lastClickAt?.toISOString()).toBe("2026-02-05T10:00:00.000Z");
      expect(rows.find((r) => r.id === idB)).toMatchObject({
        clicksInRange: 100,
        clicksTotal: 100,
      });
    });
  });

  describe("tıklama tavanı", () => {
    it("IP başına dakikalık tavan aşılınca sayılmaz; Redis yoksa sayılır; IP düz yazılmaz", async () => {
      process.env.SESSION_SECRET ??= "tracking-link-test-secret-not-real";
      const keys: string[] = [];
      let n = 0;
      const counter = async (key: string) => {
        keys.push(key);
        return ++n;
      };
      let allowed = 0;
      for (let i = 0; i < CLICK_RATE_LIMIT_PER_MINUTE + 5; i++) {
        if (await withinClickRateLimit(7, "203.0.113.9", counter)) allowed++;
      }
      expect(allowed).toBe(CLICK_RATE_LIMIT_PER_MINUTE);
      expect(keys.join()).not.toContain("203.0.113.9");

      const down = async () => {
        throw new Error("redis down");
      };
      expect(await withinClickRateLimit(7, "203.0.113.9", down)).toBe(true);
      expect(await withinClickRateLimit(7, null, counter)).toBe(true);
    });
  });
});
