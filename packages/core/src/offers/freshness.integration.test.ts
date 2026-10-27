/**
 * Karar 0156: teklif tazeliği - gerçek (yalıtılmış) Postgres.
 *
 * Politikalı beslemede uzun süredir görülmeyen teklifin fiyatı arama kartında, benzer/görsel
 * sonuçlarda, ürün sayfasının yurt dışı listesinde ve `/teklifler`de gösterilmez. Teklif
 * silinmez/pasifleşmez, fiyat geçmişi ve ürün bağı yerinde kalır. Kaynağın başarısız olduğu
 * günler "teklif kayboldu" sayılmaz; politikası olmayan besleme (Hepsiburada gibi) etkilenmez.
 * Yalnızca kendi `suffix` verisini yazar ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshProductAggregates } from "../product/refresh-aggregates.ts";
import { findAlternatives } from "../search/find-alternatives.ts";
import { search } from "../search/search.ts";
import type { QueryObject } from "../search/types.ts";
import { searchByImageVector } from "../search/visual-search.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getProductUnverifiedForeignOffers } from "./freshness.ts";
import { listFeedOffers } from "./list-feed-offers.ts";
import { getProductForeignOffers } from "./product-foreign-offers.ts";

const suffix = `fr-${Date.now().toString(36)}`;
const WORD = "zorfreshkulak";
const MODEL = `test-freshness-${suffix}`;

/** Bugünün 00:00 UTC'si: sürüm günleri gece yarısı sınırından bağımsız kurulur. */
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
/** `daysBack` gün önce, o günün `hour` saati (UTC). */
const at = (daysBack: number, hour = 12): string =>
  new Date(today.getTime() - daysBack * 86_400_000 + hour * 3_600_000).toISOString();

function axis(index: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[index] = 1;
  return vector;
}

const query = (anchor?: number): QueryObject => ({
  intent: anchor ? "similar_cheaper" : "browse",
  anchor: anchor ? { type: "product", id: anchor } : null,
  text: anchor ? "" : WORD,
  filters: {},
  style_tags: [],
  sort: anchor ? "closest_match" : "balanced",
  unparsed: anchor ? "" : WORD,
  confidence: 1,
});

describe("teklif tazeliği (karar 0156)", () => {
  let db: Database;
  const feeds: number[] = [];
  const merchants: number[] = [];
  const offers: number[] = [];
  const products: number[] = [];
  /** anahtar -> ürün kimliği */
  const p: Record<string, number> = {};
  /** anahtar -> teklif kimliği */
  const o: Record<string, number> = {};
  let anchor = 0;
  let unmatchedFresh = 0;
  let unmatchedStale = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string): Promise<number> => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $1, $1 || '.example.test', 'affiliate_network', TRUE, 80) RETURNING id`,
          [`${key}-${suffix}`],
        );
        const id = Number(row.rows[0].id);
        merchants.push(id);
        return id;
      };
      const ali = await merchant("ali");
      const tr = await merchant("tr");

      const feed = async (
        key: string,
        config: unknown,
        lastSuccessDaysBack: number,
        status = "active",
      ): Promise<number> => {
        const row = await client.query(
          `INSERT INTO feed_source (network, external_id, merchant_id, status, config, last_success_at)
           VALUES ('testfresh', $1, $2, $3, $4::jsonb, $5) RETURNING id`,
          [`${suffix}:${key}`, ali, status, JSON.stringify(config), at(lastSuccessDaysBack, 18)],
        );
        const id = Number(row.rows[0].id);
        feeds.push(id);
        return id;
      };
      /** Tamamlanmış sürümler kronolojik eklenir (kimlik artar). */
      const snapshots = async (feedId: number, times: string[]): Promise<number[]> => {
        const ids: number[] = [];
        for (const time of times) {
          const row = await client.query(
            `INSERT INTO source_snapshot (feed_source_id, status, started_at, completed_at)
             VALUES ($1, 'complete', $2, $2) RETURNING id`,
            [feedId, time],
          );
          ids.push(Number(row.rows[0].id));
        }
        return ids;
      };

      let n = 0;
      const product = async (key: string): Promise<number> => {
        const row = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`${key}-${suffix}`, `${WORD} ${key} ${suffix}`],
        );
        const id = Number(row.rows[0].id);
        products.push(id);
        p[key] = id;
        return id;
      };
      /** Ürünlü teklif + besleme üyeliği (üyelik yoksa beslemesiz teklif). */
      const offer = async (
        key: string,
        merchantId: number,
        currency: string,
        membership?: { feedId: number; snapshotId: number; lastSeen: string },
        productId: number | null = null,
      ): Promise<number> => {
        n += 1;
        const row = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, currency, is_active, in_stock, feed_source_id,
                              last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE, $8, COALESCE($9::timestamptz, now()))
           RETURNING id`,
          [
            merchantId,
            productId,
            `${key}-${suffix}`,
            `https://${key}-${suffix}.example.test/u`,
            `${WORD} ${key} ${suffix}`,
            3_000 + n,
            currency,
            membership?.feedId ?? null,
            membership?.lastSeen ?? null,
          ],
        );
        const id = Number(row.rows[0].id);
        offers.push(id);
        o[key] = id;
        if (membership) {
          await client.query(
            `INSERT INTO feed_source_offer (feed_source_id, offer_id, last_snapshot_id,
                                            first_seen_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $4)`,
            [membership.feedId, id, membership.snapshotId, membership.lastSeen],
          );
        }
        return id;
      };

      // --- Politikalı besleme: 10 gün, varsayılan en az 2 farklı başarılı gün -----------
      const policy = { freshness: { unverified_after_days: 10 } };
      const fMain = await feed("main", policy, 1);
      // A: 14 gün önce, B: 3, C: 2, D ve E: dün (AYNI UTC günü).
      const [snapA, , , , snapE] = await snapshots(fMain, [
        at(14),
        at(3),
        at(2),
        at(1, 6),
        at(1, 18),
      ]);
      const fMain2 = await feed("main2", policy, 1);
      const [snapM2] = await snapshots(fMain2, [at(1, 18)]);

      // 1) taze: son sürümde görüldü.
      await product("taze");
      await offer(
        "taze",
        ali,
        "USD",
        { feedId: fMain, snapshotId: snapE as number, lastSeen: at(1, 18) },
        p.taze,
      );
      // 2) kayıp: 12 gün önce görüldü, sonrasında 3 farklı başarılı gün teklifsiz.
      await product("kayip");
      await offer(
        "kayip",
        ali,
        "USD",
        { feedId: fMain, snapshotId: snapA as number, lastSeen: at(12) },
        p.kayip,
      );
      // 3) genç kayıp: 5 gün (eşik 10) - henüz doğrulanmış sayılır.
      await product("genc");
      await offer(
        "genc",
        ali,
        "USD",
        { feedId: fMain, snapshotId: snapA as number, lastSeen: at(5) },
        p.genc,
      );
      // 4) çoklu üyelik (fiyat bandı geçişi): eski beslemede kayıp, yenisinde taze.
      await product("band");
      await offer(
        "band",
        ali,
        "USD",
        { feedId: fMain, snapshotId: snapA as number, lastSeen: at(12) },
        p.band,
      );
      await client.query(
        `INSERT INTO feed_source_offer (feed_source_id, offer_id, last_snapshot_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [fMain2, o.band, snapM2, at(1, 18)],
      );

      // --- Kaynak başarısızlığı: tek başarılı sürüm kayıp kanıtı değildir -----------------
      const fOut = await feed("out", policy, 1);
      const outSnaps = await snapshots(fOut, [at(13), at(1, 6)]);
      await product("kesinti");
      await offer(
        "kesinti",
        ali,
        "USD",
        { feedId: fOut, snapshotId: outSnaps[0] as number, lastSeen: at(13) },
        p.kesinti,
      );

      // --- Aynı UTC gününde iki başarılı sürüm tek gün sayılır ---------------------------
      const fSame = await feed("same", policy, 1);
      const sameSnaps = await snapshots(fSame, [at(12), at(1, 6), at(1, 18)]);
      await product("ayniGun");
      await offer(
        "ayniGun",
        ali,
        "USD",
        { feedId: fSame, snapshotId: sameSnaps[0] as number, lastSeen: at(12) },
        p.ayniGun,
      );

      // --- Kaynak sağlığı sınırı tanımlı: kaynak 14 günden uzun süredir başarısız ---------
      const fSrc = await feed(
        "src",
        { freshness: { unverified_after_days: 10, source_stale_after_days: 14 } },
        20,
      );
      const [srcA] = await snapshots(fSrc, [at(20)]);
      await product("kaynakEski");
      await offer(
        "kaynakEski",
        ali,
        "USD",
        { feedId: fSrc, snapshotId: srcA as number, lastSeen: at(20) },
        p.kaynakEski,
      );
      // Aynı durum, sınır TANIMSIZ: kaynak kesintisi teklifi gizlemez.
      const fNoBound = await feed("nobound", policy, 20);
      const [nbA] = await snapshots(fNoBound, [at(20)]);
      await product("kaynakSinirsiz");
      await offer(
        "kaynakSinirsiz",
        ali,
        "USD",
        { feedId: fNoBound, snapshotId: nbA as number, lastSeen: at(20) },
        p.kaynakSinirsiz,
      );

      // --- Kapatılmış besleme: fiyat doğrulanamaz ----------------------------------------
      const fOff = await feed("off", policy, 1, "disabled");
      const [offA] = await snapshots(fOff, [at(1, 6)]);
      await product("kapali");
      await offer(
        "kapali",
        ali,
        "USD",
        { feedId: fOff, snapshotId: offA as number, lastSeen: at(1, 6) },
        p.kapali,
      );

      // --- Politikasız besleme (Hepsiburada gibi): çok eski olsa da etkilenmez ------------
      const fPlain = await feed("plain", {}, 11);
      const plainSnaps = await snapshots(fPlain, [at(12), at(2), at(1)]);
      await product("politikasiz");
      await offer(
        "politikasiz",
        ali,
        "USD",
        { feedId: fPlain, snapshotId: plainSnaps[0] as number, lastSeen: at(12) },
        p.politikasiz,
      );

      // --- Bozuk yapılandırma: sorgu hata vermez, politika yok sayılır --------------------
      const fBad = await feed(
        "bad",
        {
          freshness: {
            unverified_after_days: "abc",
            min_absent_days: -1,
            source_stale_after_days: 99999,
          },
        },
        11,
      );
      const fBad2 = await feed("bad2", { freshness: "evet" }, 11);
      const badSnaps = await snapshots(fBad, [at(12), at(2), at(1)]);
      const bad2Snaps = await snapshots(fBad2, [at(12), at(2), at(1)]);
      await product("bozuk");
      await offer(
        "bozuk",
        ali,
        "USD",
        { feedId: fBad, snapshotId: badSnaps[0] as number, lastSeen: at(12) },
        p.bozuk,
      );
      await product("bozuk2");
      await offer(
        "bozuk2",
        ali,
        "USD",
        { feedId: fBad2, snapshotId: bad2Snaps[0] as number, lastSeen: at(12) },
        p.bozuk2,
      );

      // --- Beslemesiz mağaza (ör. Shopify): hiç etkilenmez --------------------------------
      await product("yerli");
      await offer("yerli", tr, "TRY", undefined, p.yerli);

      // --- TRY doğrulanmış + yurt dışı doğrulanamayan: ürün TRY teklifiyle kalır ----------
      await product("karma");
      await offer("karma-try", tr, "TRY", undefined, p.karma);
      await offer(
        "karma-usd",
        ali,
        "USD",
        { feedId: fMain, snapshotId: snapA as number, lastSeen: at(12) },
        p.karma,
      );

      // --- Eşleşmemiş teklifler (/teklifler) ----------------------------------------------
      unmatchedFresh = await offer("bos-taze", ali, "USD", {
        feedId: fMain,
        snapshotId: snapE as number,
        lastSeen: at(1, 18),
      });
      unmatchedStale = await offer("bos-kayip", ali, "USD", {
        feedId: fMain,
        snapshotId: snapA as number,
        lastSeen: at(12),
      });

      // --- Benzerlik ve görsel: çapa ürün -------------------------------------------------
      anchor = await product("capa");
      await offer("capa", tr, "TRY", undefined, p.capa);
      for (const key of ["taze", "kayip", "kapali"]) {
        await client.query(
          `INSERT INTO similarity_edge (product_a, product_b, kind, score) VALUES ($1, $2, 'visual', 0.9)`,
          [anchor, p[key]],
        );
      }
      await client.query(
        `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
         VALUES ('offer', $1, 'image', $3, $4::vector), ('offer', $2, 'image', $3, $5::vector)`,
        [o.taze, o.kayip, MODEL, `[${axis(41).join(",")}]`, `[${axis(42).join(",")}]`],
      );
    });
    await refreshProductAggregates(db, { productIds: products });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM embedding WHERE model_version = $1", [MODEL]);
      await client.query("DELETE FROM similarity_edge WHERE product_a = $1", [anchor]);
      await client.query("DELETE FROM feed_source_offer WHERE offer_id = ANY($1)", [offers]);
      await client.query("DELETE FROM offer WHERE id = ANY($1)", [offers]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [products]);
      await client.query("DELETE FROM source_snapshot WHERE feed_source_id = ANY($1)", [feeds]);
      await client.query("DELETE FROM feed_source WHERE id = ANY($1)", [feeds]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [merchants]);
    });
  });

  const VISIBLE = [
    "taze",
    "genc",
    "band",
    "kesinti",
    "ayniGun",
    "kaynakSinirsiz",
    "politikasiz",
    "bozuk",
    "bozuk2",
    "yerli",
    "karma",
  ] as const;
  const HIDDEN = ["kayip", "kaynakEski", "kapali"] as const;

  it("arama: doğrulanamayan ürün sonuçta yok; diğer her durum görünür", async () => {
    const result = await search(db, query());
    const ids = new Set(result.items.map((item) => item.productId));
    for (const key of VISIBLE) expect(ids.has(p[key] as number), `${key} görünmeli`).toBe(true);
    for (const key of HIDDEN) expect(ids.has(p[key] as number), `${key} gizli olmalı`).toBe(false);
  });

  it("karma ürün: doğrulanamayan yurt dışı teklif değil, TRY teklif seçilir", async () => {
    const result = await search(db, query());
    const item = result.items.find((x) => x.productId === p.karma);
    const tryPrice = await withOwnerClient((client) =>
      client.query("SELECT current_price FROM offer WHERE id = $1", [o["karma-try"]]),
    );
    expect(item?.foreignPrice).toBeUndefined();
    expect(item?.minPrice).toBe(Number(tryPrice.rows[0].current_price));
  });

  it("benzer ürünler (closest_match) ve alternatifler: doğrulanamayan kart gelmez", async () => {
    const closest = await search(db, query(anchor));
    const closestIds = closest.items.map((item) => item.productId);
    expect(closestIds).toContain(p.taze);
    expect(closestIds).not.toContain(p.kayip);
    expect(closestIds).not.toContain(p.kapali);

    const alternatives = (await findAlternatives(db, anchor)).map((item) => item.productId);
    expect(alternatives).toContain(p.taze);
    expect(alternatives).not.toContain(p.kayip);
    expect(alternatives).not.toContain(p.kapali);
  });

  it("görsel arama: doğrulanamayan ürün dönmez", async () => {
    const stale = await searchByImageVector(db, axis(42), MODEL, { limit: 10 });
    expect(stale.map((item) => item.productId)).not.toContain(p.kayip);
    const fresh = await searchByImageVector(db, axis(41), MODEL, { limit: 10 });
    expect(fresh.map((item) => item.productId)).toContain(p.taze);
  });

  it("ürün sayfası: doğrulanamayan teklif listede yok; neden ve son görülme ayrı döner", async () => {
    for (const key of VISIBLE.filter((k) => k !== "yerli" && k !== "karma")) {
      const list = await getProductForeignOffers(db, p[key] as number);
      expect(
        list.map((x) => x.offerId),
        key,
      ).toEqual([o[key]]);
      expect((await getProductUnverifiedForeignOffers(db, p[key] as number)).count, key).toBe(0);
    }
    for (const key of HIDDEN) {
      expect(await getProductForeignOffers(db, p[key] as number), key).toEqual([]);
      const info = await getProductUnverifiedForeignOffers(db, p[key] as number);
      expect(info.count, key).toBe(1);
      expect(info.lastConfirmedAt, key).toBeInstanceOf(Date);
    }
    const kayip = await getProductUnverifiedForeignOffers(db, p.kayip as number);
    expect(kayip.lastConfirmedAt?.toISOString()).toBe(at(12));
  });

  it("/teklifler: eşleşmemiş doğrulanamayan teklif listelenmez", async () => {
    const page = await listFeedOffers(db, { kind: "international", q: WORD });
    const ids = page.items.map((item) => item.offerId);
    expect(ids).toContain(unmatchedFresh);
    expect(ids).not.toContain(unmatchedStale);
  });

  it("hiçbir şey silinmedi/pasifleşmedi: teklif, ürün bağı ve üyelik yerinde", async () => {
    const row = await withOwnerClient((client) =>
      client.query(
        `SELECT o.is_active, o.deactivated_at, o.product_id, o.in_stock,
                (SELECT count(*) FROM feed_source_offer m WHERE m.offer_id = o.id)::int AS memberships
           FROM offer o WHERE o.id = $1`,
        [o.kayip],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      is_active: true,
      deactivated_at: null,
      product_id: String(p.kayip),
      in_stock: true,
      memberships: 1,
    });
  });
});
