/**
 * Karar 0156 eki: tazelik politikasının arama ADAY penceresindeki ve TRY/diğer teklif gösterim
 * yüzeylerindeki davranışı - gerçek (yalıtılmış) Postgres. Yalnızca kendi `suffix` verisini
 * yazar ve siler. Ana davranış testi: `freshness.integration.test.ts`.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProductPriceComparison } from "../product/get-price-comparison.ts";
import { getSizeOptions } from "../product/get-size-options.ts";
import { compareMerchants } from "../search/compare-merchants.ts";
import { search } from "../search/search.ts";
import { withCandidatePlan } from "../search/search-sql.ts";
import { candidateCtes } from "../search/text-match.ts";
import type { QueryObject } from "../search/types.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getProductForeignOffers } from "./product-foreign-offers.ts";

const suffix = `fc-${Date.now().toString(36)}`;
const WINDOW_WORD = "zorpencerekulak";
const SURFACE_WORD = "zoryuzeykulak";

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const at = (daysBack: number, hour = 12): string =>
  new Date(today.getTime() - daysBack * 86_400_000 + hour * 3_600_000).toISOString();

const textQuery = (word: string): QueryObject => ({
  intent: "browse",
  anchor: null,
  text: word,
  filters: {},
  style_tags: [],
  sort: "balanced",
  unparsed: word,
  confidence: 1,
});

describe("tazelik politikası: aday penceresi ve gösterim yüzeyleri (karar 0156 eki)", () => {
  let db: Database;
  const feeds: number[] = [];
  const merchants: number[] = [];
  const offers: number[] = [];
  const products: number[] = [];
  const p: Record<string, number> = {};
  const o: Record<string, number> = {};
  let categoryId = 0;
  let sentinelPrice = 0;
  let retFeed = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string): Promise<number> => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $1, $1 || '.example.test', 'affiliate_network', TRUE, 80) RETURNING id`,
          [`${key}-${suffix}`],
        );
        merchants.push(Number(row.rows[0].id));
        return Number(row.rows[0].id);
      };
      const ali = await merchant("ali");
      const trFeed = await merchant("trfeed");
      const trPlain = await merchant("trplain");
      const hb = await merchant("hbbenzeri");

      const feed = async (key: string, merchantId: number, config: unknown): Promise<number> => {
        const row = await client.query(
          `INSERT INTO feed_source (network, external_id, merchant_id, status, config, last_success_at)
           VALUES ('testfresh', $1, $2, 'active', $3::jsonb, $4) RETURNING id`,
          [`${suffix}:${key}`, merchantId, JSON.stringify(config), at(1, 18)],
        );
        feeds.push(Number(row.rows[0].id));
        return Number(row.rows[0].id);
      };
      const snapshot = async (
        feedId: number,
        time: string,
        status = "complete",
      ): Promise<number> => {
        const row = await client.query(
          `INSERT INTO source_snapshot (feed_source_id, status, started_at, completed_at)
           VALUES ($1, $2, $3, $3) RETURNING id`,
          [feedId, status, time],
        );
        return Number(row.rows[0].id);
      };
      const product = async (key: string, word: string, category?: number): Promise<number> => {
        const row = await client.query(
          "INSERT INTO product (slug, title, category_id) VALUES ($1, $2, $3) RETURNING id",
          [`${key}-${suffix}`, `${word} ${key} ${suffix}`, category ?? null],
        );
        products.push(Number(row.rows[0].id));
        p[key] = Number(row.rows[0].id);
        return p[key] as number;
      };
      let n = 0;
      const offer = async (
        key: string,
        merchantId: number,
        currency: string,
        productId: number,
        membership?: { feedId: number; snapshotId: number; lastSeen: string },
      ): Promise<number> => {
        n += 1;
        const row = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                              currency, is_active, in_stock, feed_source_id, last_seen_at)
           VALUES ($1, $2, $3, $4, $3, $5, $6, TRUE, TRUE, $7, COALESCE($8::timestamptz, now()))
           RETURNING id`,
          [
            merchantId,
            productId,
            `${key}-${suffix}`,
            `https://${key}-${suffix}.example.test/u`,
            1_000 + n,
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
            `INSERT INTO feed_source_offer (feed_source_id, offer_id, last_snapshot_id, first_seen_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $4)`,
            [membership.feedId, id, membership.snapshotId, membership.lastSeen],
          );
        }
        return id;
      };

      const policy = { freshness: { unverified_after_days: 10 } };

      // --- Aday penceresi: 8 doğrulanamayan ürün ÖNCE, 3 güncel ürün SONRA eklenir ------------
      const fWin = await feed("win", ali, policy);
      const winA = await snapshot(fWin, at(14));
      const winB = await snapshot(fWin, at(3));
      const winC = await snapshot(fWin, at(2));
      const winD = await snapshot(fWin, at(1, 18));
      for (let i = 0; i < 8; i++) {
        await product(`eski${i}`, WINDOW_WORD);
        await offer(`eski${i}`, ali, "USD", p[`eski${i}`] as number, {
          feedId: fWin,
          snapshotId: winA,
          lastSeen: at(12),
        });
      }
      for (let i = 0; i < 3; i++) {
        await product(`taze${i}`, WINDOW_WORD);
        await offer(`taze${i}`, ali, "USD", p[`taze${i}`] as number, {
          feedId: fWin,
          snapshotId: winD,
          lastSeen: at(1, 18),
        });
      }
      void winB;
      void winC;
      // Teklifi hiç olmayan ürün eskisi gibi aday kalır (özet gecikmesi).
      await product("teklifsiz", WINDOW_WORD);

      // --- TRY yüzeyleri: politikalı TRY beslemesi ---------------------------------------
      const fTry = await feed("try", trFeed, policy);
      const trA = await snapshot(fTry, at(14));
      await snapshot(fTry, at(3));
      await snapshot(fTry, at(2));
      const trD = await snapshot(fTry, at(1, 18));
      // Politikasız (Hepsiburada benzeri) TRY beslemesi: çok eski üyelik de gösterilir.
      const fHb = await feed("hb", hb, {});
      const hbA = await snapshot(fHb, at(14));
      await snapshot(fHb, at(3));
      await snapshot(fHb, at(2));
      await snapshot(fHb, at(1, 18));

      categoryId = Number(
        (await client.query("SELECT id FROM category ORDER BY id LIMIT 1")).rows[0].id,
      );
      // karma: eski (ucuz) politikalı TRY teklifi + taze beslemesiz TRY teklifi.
      await product("karma", SURFACE_WORD, categoryId);
      await offer("karma-eski", trFeed, "TRY", p.karma as number, {
        feedId: fTry,
        snapshotId: trA,
        lastSeen: at(12),
      });
      await offer("karma-taze", trPlain, "TRY", p.karma as number);
      // sadece eski: hiçbir TRY teklif gösterilemez.
      await product("sadeceEski", SURFACE_WORD, categoryId);
      await offer("sadeceEski", trFeed, "TRY", p.sadeceEski as number, {
        feedId: fTry,
        snapshotId: trA,
        lastSeen: at(12),
      });
      // taze politikalı TRY teklifi gösterilir.
      await product("tryTaze", SURFACE_WORD, categoryId);
      await offer("tryTaze", trFeed, "TRY", p.tryTaze as number, {
        feedId: fTry,
        snapshotId: trD,
        lastSeen: at(1, 18),
      });
      // HB benzeri: çok eski üyelik ama politika yok -> gösterilir.
      await product("hbBenzeri", SURFACE_WORD, categoryId);
      await offer("hbBenzeri", hb, "TRY", p.hbBenzeri as number, {
        feedId: fHb,
        snapshotId: hbA,
        lastSeen: at(12),
      });
      // --- Başarısız çalışmalar: failed/rejected sürümler "teklifsiz gün" sayılmaz ------------
      const fRun = await feed("run", ali, policy);
      const runA = await snapshot(fRun, at(14));
      await snapshot(fRun, at(9), "failed");
      await snapshot(fRun, at(6), "rejected");
      await snapshot(fRun, at(4), "failed");
      await snapshot(fRun, at(1, 18)); // tek başarılı, teklifsiz sürüm
      await product("basarisiz", SURFACE_WORD);
      await offer("basarisiz", ali, "USD", p.basarisiz as number, {
        feedId: fRun,
        snapshotId: runA,
        lastSeen: at(12),
      });

      // --- Geri dönen teklif: önce doğrulanamaz, yeni sürümde görülünce yeniden görünür ------
      const fRet = await feed("ret", ali, policy);
      const retA = await snapshot(fRet, at(14));
      await snapshot(fRet, at(3));
      await snapshot(fRet, at(2));
      await product("donen", SURFACE_WORD);
      await offer("donen", ali, "USD", p.donen as number, {
        feedId: fRet,
        snapshotId: retA,
        lastSeen: at(12),
      });
      retFeed = fRet;

      // Beden seçenekleri: eski teklifin bedeni görünmez, taze teklifinki görünür.
      for (const [key, size] of [
        ["karma-eski", "38"],
        ["karma-taze", "40"],
      ] as const) {
        await client.query(
          `INSERT INTO offer_variant (offer_id, external_id, size_label, size_norm, in_stock)
           VALUES ($1, $2, $3, $3, TRUE)`,
          [o[key], `${key}-${suffix}`, size],
        );
      }

      // --- Fiyat geçmişi: doğrulanamayan teklifin price_point satırları yerinde kalır -------
      for (const [daysBack, price] of [
        [20, 900],
        [13, 950],
      ] as const) {
        await client.query(
          `INSERT INTO price_point (offer_id, observed_at, price, in_stock) VALUES ($1, $2, $3, TRUE)`,
          [o["sadeceEski"], at(daysBack), price],
        );
      }
      sentinelPrice = Number(
        (await client.query("SELECT current_price FROM offer WHERE id = $1", [o["sadeceEski"]]))
          .rows[0].current_price,
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM price_point WHERE offer_id = ANY($1)", [offers]);
      await client.query("DELETE FROM feed_source_offer WHERE offer_id = ANY($1)", [offers]);
      await client.query("DELETE FROM offer WHERE id = ANY($1)", [offers]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [products]);
      await client.query("DELETE FROM source_snapshot WHERE feed_source_id = ANY($1)", [feeds]);
      await client.query("DELETE FROM feed_source WHERE id = ANY($1)", [feeds]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [merchants]);
    });
  });

  const candidates = async (limit: number): Promise<number[]> => {
    const result = await db.execute<{ id: string }>(
      sql`WITH ${candidateCtes([[WINDOW_WORD]], {}, { limit })} SELECT id FROM cand`,
    );
    return result.rows.map((row) => Number(row.id));
  };

  it("aday penceresi: sınır 5 iken doğrulanamayan 8 ürün güncel 3 ürünün yerini işgal etmez", async () => {
    const ids = await candidates(5);
    for (let i = 0; i < 3; i++) expect(ids, `taze${i}`).toContain(p[`taze${i}`]);
    for (let i = 0; i < 8; i++) expect(ids, `eski${i}`).not.toContain(p[`eski${i}`]);
    // Teklifi olmayan ürün (özet gecikmesi) eski davranışla aday kalır.
    expect(ids).toContain(p.teklifsiz);
  });

  it("aday aşaması JIT'i kapatır (enable_seqscan cezası plan maliyetini şişirip JIT'i tetikliyordu)", async () => {
    const jit = await withCandidatePlan(db, textQuery(WINDOW_WORD), async (tx) => {
      const result = await tx.execute<{ jit: string }>(sql`SHOW jit`);
      return result.rows[0]?.jit;
    });
    expect(jit).toBe("off");
  });

  it("aday penceresi: politika hiç yokken (kaynak yapılandırması boşken) hiçbir ürün elenmez", async () => {
    const before = await withOwnerClient((client) =>
      client.query(
        "SELECT id, config FROM feed_source WHERE id = ANY($1) AND config ? 'freshness'",
        [feeds],
      ),
    );
    expect(before.rowCount).toBeGreaterThan(0);
    try {
      await withOwnerClient((client) =>
        client.query("UPDATE feed_source SET config = config - 'freshness' WHERE id = ANY($1)", [
          feeds,
        ]),
      );
      const ids = await candidates(50);
      for (let i = 0; i < 8; i++) expect(ids, `eski${i}`).toContain(p[`eski${i}`]);
    } finally {
      for (const row of before.rows) {
        await withOwnerClient((client) =>
          client.query("UPDATE feed_source SET config = $2::jsonb WHERE id = $1", [
            row.id,
            JSON.stringify(row.config),
          ]),
        );
      }
    }
  });

  it("metin araması: pencere dolu olsa da güncel ürünler sonuçta, eski ürünler yok", async () => {
    const result = await search(db, textQuery(WINDOW_WORD));
    const ids = new Set(result.items.map((item) => item.productId));
    for (let i = 0; i < 3; i++) expect(ids.has(p[`taze${i}`] as number)).toBe(true);
    for (let i = 0; i < 8; i++) expect(ids.has(p[`eski${i}`] as number)).toBe(false);
  });

  it("TRY mağaza listesi: eski politikalı teklif gösterilmez, taze beslemesiz teklif gösterilir", async () => {
    const karma = await compareMerchants(db, p.karma as number);
    expect(karma.map((x) => x.offerId)).toEqual([o["karma-taze"]]);
    expect(await compareMerchants(db, p.sadeceEski as number)).toEqual([]);
    expect((await compareMerchants(db, p.tryTaze as number)).map((x) => x.offerId)).toEqual([
      o.tryTaze,
    ]);
  });

  it("fiyat karşılaştırması ve beden seçenekleri aynı kuralı izler", async () => {
    const comparison = await getProductPriceComparison(db, p.karma as number, null);
    expect(comparison.merchantOffers.map((x) => x.offerId)).toEqual([o["karma-taze"]]);
    expect(
      (await getProductPriceComparison(db, p.sadeceEski as number, null)).merchantOffers,
    ).toEqual([]);
    const sizes = (await getSizeOptions(db, p.karma as number)).map((x) => x.sizeNorm);
    expect(sizes).toEqual(["40"]);
  });

  it("politikasız (Hepsiburada benzeri) TRY teklif çok eski üyelikle de her yüzeyde görünür", async () => {
    expect((await compareMerchants(db, p.hbBenzeri as number)).map((x) => x.offerId)).toEqual([
      o.hbBenzeri,
    ]);
    const result = await search(db, textQuery(SURFACE_WORD));
    const item = result.items.find((x) => x.productId === p.hbBenzeri);
    expect(item).toBeDefined();
  });

  it("silinmedi/pasifleşmedi: ürün, kategori, teklif ve fiyat geçmişi aynen yerinde", async () => {
    // Yukarıdaki tüm okumalardan SONRA durum.
    const state = await withOwnerClient(async (client) => {
      const product = await client.query(
        "SELECT id, category_id FROM product WHERE id = ANY($1) ORDER BY id",
        [[p.sadeceEski, p.karma]],
      );
      const offer = await client.query(
        "SELECT is_active, deactivated_at, in_stock, current_price, product_id FROM offer WHERE id = $1",
        [o["sadeceEski"]],
      );
      const history = await client.query(
        "SELECT price FROM price_point WHERE offer_id = $1 ORDER BY observed_at",
        [o["sadeceEski"]],
      );
      const member = await client.query(
        "SELECT count(*)::int AS n FROM feed_source_offer WHERE offer_id = $1",
        [o["sadeceEski"]],
      );
      return { product, offer, history, member };
    });
    expect(state.product.rows.map((r) => Number(r.category_id))).toEqual([categoryId, categoryId]);
    expect(state.offer.rows[0]).toMatchObject({
      is_active: true,
      deactivated_at: null,
      in_stock: true,
      product_id: String(p.sadeceEski),
    });
    expect(Number(state.offer.rows[0].current_price)).toBe(sentinelPrice);
    expect(state.history.rows.map((r) => Number(r.price))).toEqual([900, 950]);
    expect(state.member.rows[0].n).toBe(1);
  });

  it("başarısız/reddedilen çalışmalar kayıp kanıtı değil: tek başarılı sürüm teklifi gizlemez", async () => {
    const list = await getProductForeignOffers(db, p.basarisiz as number);
    expect(list.map((x) => x.offerId)).toEqual([o.basarisiz]);
    const ids = (await search(db, textQuery(SURFACE_WORD))).items.map((x) => x.productId);
    expect(ids).toContain(p.basarisiz);
  });

  it("geri dönen teklif: yeni başarılı sürümde görülünce aynı satır yeniden görünür, geçmişi sürer", async () => {
    // Başlangıç: 12 gün önce görüldü, sonrasında 3 farklı başarılı gün teklifsiz.
    expect(await getProductForeignOffers(db, p.donen as number)).toEqual([]);
    const sync = await withOwnerClient(async (client) => {
      const snap = await client.query(
        `INSERT INTO source_snapshot (feed_source_id, status, started_at, completed_at)
         VALUES ($1, 'complete', $2, $2) RETURNING id`,
        [retFeed, at(0, 1)],
      );
      // FeedSync'in yaptığı: üyelik yeni sürüme taşınır, son görülme güncellenir.
      await client.query(
        `UPDATE feed_source_offer SET last_snapshot_id = $2, last_seen_at = $3
          WHERE offer_id = $1`,
        [o.donen, snap.rows[0].id, at(0, 1)],
      );
      return Number(snap.rows[0].id);
    });
    expect(sync).toBeGreaterThan(0);
    const back = await getProductForeignOffers(db, p.donen as number);
    expect(back.map((x) => x.offerId)).toEqual([o.donen]);
    const ids = (await search(db, textQuery(SURFACE_WORD))).items.map((x) => x.productId);
    expect(ids).toContain(p.donen);
  });

  it("yabancı teklif listesi pencere ürünlerinde aynı kuralı izler", async () => {
    expect(await getProductForeignOffers(db, p.eski0 as number)).toEqual([]);
    const fresh = await getProductForeignOffers(db, p.taze0 as number);
    expect(fresh.map((x) => x.offerId)).toEqual([o.taze0]);
  });
});
