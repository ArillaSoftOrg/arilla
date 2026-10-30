/**
 * Karar 0159: kaydedilen ürünün fiyat değişimi - gerçek (yalıtılmış) Postgres.
 *
 * Aynı teklifin kayıt anındaki `price_point` gözlemi ile bugünkü `current_price`ı
 * karşılaştırılır. Başka satıcıya, para birimine, varyanta ya da doğrulanamayan
 * teklife geçilmez; kayıt anına ait gözlem yoksa sonuç uydurulmaz.
 * Yalnızca kendi `suffix` verisini yazar ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshProductAggregates } from "../product/refresh-aggregates.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listSavedItems } from "./saved-items.ts";
import { getSavedPriceChanges, type SavedPriceChange } from "./saved-price-change.ts";

const suffix = `spc-${Date.now().toString(36)}`;
const HOUR = 3_600_000;
const now = Date.now();
/** Kullanıcı A'nın kayıt anı: 3 gün önce. */
const SAVED_A = new Date(now - 72 * HOUR);
/** `SAVED_A`'ya göre saat farkı. */
const rel = (hours: number) => new Date(SAVED_A.getTime() + hours * HOUR).toISOString();
const daysAgo = (days: number) => new Date(now - days * 24 * HOUR).toISOString();

describe("kaydedilen ürünün fiyat değişimi (karar 0159)", () => {
  let db: Database;
  const ids = {
    users: [] as number[],
    merchants: [] as number[],
    products: [] as number[],
    offers: [] as number[],
    feeds: [] as number[],
  };
  /** anahtar -> ürün */
  const p: Record<string, number> = {};
  let userA = 0;
  let userB = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string, active = true) => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $1, $1 || '.example.test', 'affiliate_network', $2, 80) RETURNING id`,
          [`${key}-${suffix}`, active],
        );
        const id = Number(row.rows[0].id);
        ids.merchants.push(id);
        return id;
      };
      const m1 = await merchant("m1");
      const m2 = await merchant("m2");
      const mPassive = await merchant("pasif", false);

      const product = async (key: string, state = "published") => {
        const source = state === "published" ? [null, null] : [m1, `${key}-${suffix}`];
        const row = await client.query(
          `INSERT INTO product (slug, title, publication_state, source_merchant_id, source_external_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [`${key}-${suffix}`, `Ürün ${key}`, state, ...source],
        );
        const id = Number(row.rows[0].id);
        ids.products.push(id);
        p[key] = id;
        return id;
      };

      let n = 0;
      const offer = async (
        productKey: string,
        opts: {
          price: number;
          merchantId?: number;
          currency?: string;
          inStock?: boolean;
          feedId?: number | null;
          /** [saat (SAVED_A'ya göre), fiyat] */
          history?: [number, number][];
          /** `offer.last_seen_at`; varsayılan şimdi. */
          lastSeen?: string;
          /**
           * Bugünkü fiyatın gözlemi (1 saat önce). Varsayılan: `price` (toplayıcı her koşuda
           * yazar). `null`: gözlem yok (besleme yalnız değişimde yazar); sayı: farklı fiyat.
           */
          observedNow?: number | null;
        },
      ) => {
        n += 1;
        const row = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                              currency, is_active, in_stock, feed_source_id, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, COALESCE($10::timestamptz, now()))
           RETURNING id`,
          [
            opts.merchantId ?? m1,
            p[productKey],
            `o${n}-${suffix}`,
            `https://o${n}-${suffix}.example.test/u`,
            `Teklif ${n}`,
            opts.price,
            opts.currency ?? "TRY",
            opts.inStock ?? true,
            opts.feedId ?? null,
            opts.lastSeen ?? null,
          ],
        );
        const id = Number(row.rows[0].id);
        ids.offers.push(id);
        const observedNow = opts.observedNow === undefined ? opts.price : opts.observedNow;
        const points = [...(opts.history ?? [])];
        if (observedNow !== null)
          points.push([(now - HOUR - SAVED_A.getTime()) / HOUR, observedNow]);
        for (const [hours, price] of points) {
          await client.query(
            "INSERT INTO price_point (offer_id, observed_at, price, in_stock) VALUES ($1, $2, $3, TRUE)",
            [id, rel(hours), price],
          );
        }
        return id;
      };

      // --- Temel durumlar ----------------------------------------------------------------
      await product("dusus");
      await offer("dusus", { price: 750_00, history: [[-2, 1000_00]] });
      await product("artis");
      await offer("artis", { price: 1200_00, history: [[-2, 1000_00]] });
      await product("ayni");
      await offer("ayni", { price: 1000_00, history: [[-2, 1000_00]] });

      // --- Veri yetersiz -------------------------------------------------------------------
      await product("gecmissiz");
      await offer("gecmissiz", { price: 900_00 });
      // Kayıttan 5 gün önceki gözlem kayıt anındaki fiyat sayılmaz (48 saat sınırı).
      await product("eski-gozlem");
      await offer("eski-gozlem", { price: 900_00, history: [[-120, 1000_00]] });
      // Yalnız kayıttan SONRA gözlem: geriye taşınmaz.
      await product("kayit-sonrasi");
      await offer("kayit-sonrasi", { price: 900_00, history: [[1, 1000_00]] });

      // --- Kayıt anı gözlemler arasında: son ÖNCEKİ gözlem esas ---------------------------
      await product("arada");
      await offer("arada", {
        price: 950_00,
        history: [
          [-30, 900_00],
          [-1, 1000_00],
          [1, 800_00],
        ],
      });

      // --- Birden çok satıcı: referans BUGÜNKÜ en uygun teklif, kendi geçmişiyle -----------
      await product("coklu");
      await offer("coklu", { price: 800_00, merchantId: m1, history: [[-2, 900_00]] });
      // Kayıt anında daha ucuz olan başka satıcı: min-min karşılaştırmaya girmez.
      await offer("coklu", { price: 1000_00, merchantId: m2, history: [[-2, 700_00]] });
      // Bugünkü en uygun teklifin geçmişi yoksa başka satıcıya geçilmez.
      await product("coklu-gecmissiz");
      await offer("coklu-gecmissiz", { price: 500_00, merchantId: m1 });
      await offer("coklu-gecmissiz", { price: 900_00, merchantId: m2, history: [[-2, 1000_00]] });

      // --- Doğrulanamayan teklif (karar 0156) ---------------------------------------------
      const feed = await client.query(
        `INSERT INTO feed_source (network, external_id, merchant_id, status, config, last_success_at)
         VALUES ('testspc', $1, $2, 'active', '{"freshness":{"unverified_after_days":10}}'::jsonb, now())
         RETURNING id`,
        [`${suffix}:feed`, m2],
      );
      const feedId = Number(feed.rows[0].id);
      ids.feeds.push(feedId);
      const snaps: number[] = [];
      for (const time of [daysAgo(14), daysAgo(3), daysAgo(2)]) {
        const row = await client.query(
          `INSERT INTO source_snapshot (feed_source_id, status, started_at, completed_at)
           VALUES ($1, 'complete', $2, $2) RETURNING id`,
          [feedId, time],
        );
        snaps.push(Number(row.rows[0].id));
      }
      const staleOffer = async (productKey: string, price: number) => {
        const offerId = await offer(productKey, {
          price,
          merchantId: m2,
          feedId,
          history: [[-2, price + 100_00]],
        });
        await client.query(
          `INSERT INTO feed_source_offer (feed_source_id, offer_id, last_snapshot_id, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [feedId, offerId, snaps[0], daysAgo(14)],
        );
      };
      await product("dogrulanamayan-karma");
      await staleOffer("dogrulanamayan-karma", 100_00);
      await offer("dogrulanamayan-karma", { price: 900_00, history: [[-2, 1000_00]] });
      await product("dogrulanamayan-tek");
      await staleOffer("dogrulanamayan-tek", 100_00);

      // --- Para birimi: yurt dışı teklif kuruş gibi okunmaz -------------------------------
      await product("yabanci-tek");
      await offer("yabanci-tek", { price: 50_00, currency: "USD", history: [[-2, 60_00]] });
      await product("yabanci-karma");
      await offer("yabanci-karma", { price: 50_00, currency: "USD", history: [[-2, 40_00]] });
      await offer("yabanci-karma", { price: 1000_00, history: [[-2, 1100_00]] });

      // --- Varyant fiyatlı ürün: teklif düzeyi geçmiş beden fiyatını ayırmaz -------------
      await product("varyant");
      const variantOffer = await offer("varyant", { price: 1000_00, history: [[-2, 1200_00]] });
      for (const [size, override] of [
        ["38", 1000_00],
        ["40", 1300_00],
      ] as const) {
        await client.query(
          `INSERT INTO offer_variant (offer_id, external_id, size_label, size_norm, in_stock, price_override)
           VALUES ($1, $2, $3, $3, TRUE, $4)`,
          [variantOffer, `${size}-${suffix}`, size, override],
        );
      }

      // --- Erişilemeyen / gösterilemeyen ---------------------------------------------------
      await product("taslak", "draft");
      await offer("taslak", { price: 750_00, history: [[-2, 1000_00]] });
      await product("stok-disi");
      await offer("stok-disi", { price: 750_00, inStock: false, history: [[-2, 1000_00]] });
      await product("pasif-magaza");
      await offer("pasif-magaza", {
        price: 750_00,
        merchantId: mPassive,
        history: [[-2, 1000_00]],
      });

      // --- Ek güvenlik koşulları (bugünkü fiyatın güvenilirliği) ---------------------------
      // Kaynakta 10 gündür görülmeyen, tazelik politikası olmayan teklif: eski fiyat bugünkü sayılmaz.
      await product("bayat");
      await offer("bayat", {
        price: 1000_00,
        history: [[-2, 1000_00]],
        observedNow: null,
        lastSeen: daysAgo(10),
      });
      // Besleme yalnız değişimde `price_point` yazar: fiyat sabit, gözlem eski ama üyelik taze.
      const plainFeed = await client.query(
        `INSERT INTO feed_source (network, external_id, merchant_id, status, config, last_success_at)
         VALUES ('testspc', $1, $2, 'active', '{}'::jsonb, now()) RETURNING id`,
        [`${suffix}:plain`, m1],
      );
      const plainFeedId = Number(plainFeed.rows[0].id);
      ids.feeds.push(plainFeedId);
      const plainSnap = await client.query(
        `INSERT INTO source_snapshot (feed_source_id, status, started_at, completed_at)
         VALUES ($1, 'complete', now(), now()) RETURNING id`,
        [plainFeedId],
      );
      await product("uyelik-taze");
      const memberOffer = await offer("uyelik-taze", {
        price: 1000_00,
        feedId: plainFeedId,
        history: [[-2, 1000_00]],
        observedNow: null,
        lastSeen: daysAgo(10),
      });
      await client.query(
        `INSERT INTO feed_source_offer (feed_source_id, offer_id, last_snapshot_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
        [plainFeedId, memberOffer, Number(plainSnap.rows[0].id), daysAgo(20)],
      );
      // Bugünkü `current_price` hiç gözlenmemiş (son gözlem başka fiyat).
      await product("gozlenmemis");
      await offer("gozlenmemis", { price: 700_00, history: [[-2, 1000_00]], observedNow: 800_00 });
      // Kartın gösterdiği özet farklı (aşağıda refresh sonrası elle bayatlatılır).
      await product("ozet-farkli");
      await offer("ozet-farkli", { price: 750_00, history: [[-2, 1000_00]] });
      // Stok dışı daha ucuz teklif özeti düşürür: kart 500 TL der, gösterge 900 TL'ye dayanamaz.
      await product("stoksuz-ucuz");
      await offer("stoksuz-ucuz", { price: 900_00, history: [[-2, 1000_00]] });
      await offer("stoksuz-ucuz", { price: 500_00, merchantId: m2, inStock: false });

      // --- Kullanıcılar ---------------------------------------------------------------------
      const user = async (key: string) => {
        const row = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
          `${key}-${suffix}@test.local`,
        ]);
        const id = Number(row.rows[0].id);
        ids.users.push(id);
        return id;
      };
      userA = await user("a");
      userB = await user("b");
      for (const key of Object.keys(p)) {
        await client.query(
          "INSERT INTO saved_item (user_id, product_id, created_at) VALUES ($1, $2, $3)",
          [userA, p[key], SAVED_A.toISOString()],
        );
      }
      // B aynı ürünü düşüşten SONRA kaydetti: onun için fiyat değişmedi.
      await client.query(
        "INSERT INTO price_point (offer_id, observed_at, price, in_stock) SELECT id, $2, 750_00, TRUE FROM offer WHERE product_id = $1",
        [p.dusus, rel(24)],
      );
      await client.query(
        "INSERT INTO saved_item (user_id, product_id, created_at) VALUES ($1, $2, $3)",
        [userB, p.dusus, rel(25)],
      );
    });
    // Kartın okuduğu özet, üretimdeki gibi tek kuraldan (`refresh_product_aggregates`).
    await refreshProductAggregates(db, { productIds: ids.products });
    await withOwnerClient((client) =>
      client.query("UPDATE product SET min_price = 600_00 WHERE id = $1", [p["ozet-farkli"]]),
    );
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM saved_item WHERE user_id = ANY($1)", [ids.users]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [ids.users]);
      await client.query("DELETE FROM price_point WHERE offer_id = ANY($1)", [ids.offers]);
      await client.query("DELETE FROM feed_source_offer WHERE offer_id = ANY($1)", [ids.offers]);
      await client.query("DELETE FROM offer WHERE id = ANY($1)", [ids.offers]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [ids.products]);
      await client.query("DELETE FROM source_snapshot WHERE feed_source_id = ANY($1)", [ids.feeds]);
      await client.query("DELETE FROM feed_source WHERE id = ANY($1)", [ids.feeds]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [ids.merchants]);
    });
  });

  async function changeFor(key: string, userId = userA): Promise<SavedPriceChange | undefined> {
    return (await getSavedPriceChanges(db, userId)).get(p[key] as number);
  }

  it("fiyat düşüşü: TL ve yüzde, kuruş cinsinden", async () => {
    expect(await changeFor("dusus")).toEqual({
      kind: "down",
      savedPriceKurus: 1000_00,
      currentPriceKurus: 750_00,
      diffKurus: 250_00,
      percent: 25,
    });
  });

  it("fiyat artışı ve değişmeme", async () => {
    expect(await changeFor("artis")).toMatchObject({ kind: "up", diffKurus: 200_00, percent: 20 });
    expect(await changeFor("ayni")).toMatchObject({ kind: "same", diffKurus: 0, percent: 0 });
  });

  it.each(["gecmissiz", "eski-gozlem", "kayit-sonrasi"])(
    "%s: kayıt anına ait gözlem yok, sonuç uydurulmaz",
    async (key) => {
      expect(await changeFor(key)).toEqual({ kind: "insufficient" });
    },
  );

  it("kayıt anı gözlemler arasındaysa kayıttan önceki SON gözlem esas alınır", async () => {
    expect(await changeFor("arada")).toMatchObject({
      kind: "down",
      savedPriceKurus: 1000_00,
      currentPriceKurus: 950_00,
      diffKurus: 50_00,
      percent: 5,
    });
  });

  it("birden çok satıcı: bugünkü en uygun teklif kendi geçmişiyle; satıcılar karışmaz", async () => {
    expect(await changeFor("coklu")).toMatchObject({
      kind: "down",
      savedPriceKurus: 900_00,
      currentPriceKurus: 800_00,
    });
    expect(await changeFor("coklu-gecmissiz")).toEqual({ kind: "insufficient" });
  });

  it("doğrulanamayan teklif güncel fiyat sayılmaz; kartı da etkiliyorsa gösterge gizlenir", async () => {
    // Doğrulanmış teklif 900 TL ama kartın özeti doğrulanamayan 100 TL'yi gösterir:
    // kartla çelişen "bugünkü fiyat" yerine gösterge gizlenir, 100 TL de kullanılmaz.
    expect(await changeFor("dogrulanamayan-karma")).toEqual({ kind: "insufficient" });
    expect(await changeFor("dogrulanamayan-tek")).toEqual({ kind: "insufficient" });
  });

  it("tazelik politikası yokken kaynakta günlerdir görülmeyen teklif bugünkü fiyat sayılmaz", async () => {
    expect(await changeFor("bayat")).toEqual({ kind: "insufficient" });
  });

  it("besleme yalnız değişimde gözlem yazar: üyelik tazeyse sabit fiyat 'değişmedi' olur", async () => {
    expect(await changeFor("uyelik-taze")).toMatchObject({
      kind: "same",
      savedPriceKurus: 1000_00,
      currentPriceKurus: 1000_00,
    });
  });

  it("bugünkü fiyat hiç gözlenmemişse gösterge yok", async () => {
    expect(await changeFor("gozlenmemis")).toEqual({ kind: "insufficient" });
  });

  it("kartın fiyatı (product.min_price) referans teklifle aynı değilse gösterge yok", async () => {
    expect(await changeFor("ozet-farkli")).toEqual({ kind: "insufficient" });
    expect(await changeFor("stoksuz-ucuz")).toEqual({ kind: "insufficient" });
  });

  it("gösterilen her değişimde bugünkü fiyat kartın fiyatıyla aynı", async () => {
    const changes = await getSavedPriceChanges(db, userA);
    const cards = new Map(
      (await listSavedItems(db, userA)).map((item) => [item.productId, item.minPrice]),
    );
    let shown = 0;
    for (const [productId, change] of changes) {
      if (change.kind === "insufficient") continue;
      shown += 1;
      expect([productId, change.currentPriceKurus]).toEqual([productId, cards.get(productId)]);
    }
    expect(shown).toBeGreaterThanOrEqual(6);
  });

  it("para birimleri karışmaz: yalnız TRY teklif", async () => {
    expect(await changeFor("yabanci-tek")).toEqual({ kind: "insufficient" });
    expect(await changeFor("yabanci-karma")).toMatchObject({
      kind: "down",
      savedPriceKurus: 1100_00,
      currentPriceKurus: 1000_00,
    });
  });

  it("varyant fiyatlı ürün karşılaştırılmaz", async () => {
    expect(await changeFor("varyant")).toEqual({ kind: "insufficient" });
  });

  it.each(["taslak", "stok-disi", "pasif-magaza"])(
    "%s: gösterilebilir teklif yok, karşılaştırma yok",
    async (key) => {
      expect(await changeFor(key)).toEqual({ kind: "insufficient" });
    },
  );

  it("kullanıcılar arası izolasyon: herkes yalnız kendi kayıtlarını, kendi kayıt anıyla görür", async () => {
    const a = await getSavedPriceChanges(db, userA);
    const b = await getSavedPriceChanges(db, userB);
    expect(a.size).toBe(Object.keys(p).length);
    expect([...b.keys()]).toEqual([p.dusus]);
    expect(b.get(p.dusus as number)).toMatchObject({ kind: "same", savedPriceKurus: 750_00 });
    expect(a.get(p.dusus as number)).toMatchObject({ kind: "down", savedPriceKurus: 1000_00 });
  });

  it("her kayıtlı ürün haritada; mevcut liste okuması değişmedi", async () => {
    const changes = await getSavedPriceChanges(db, userA);
    const listed = await listSavedItems(db, userA);
    expect(new Set(listed.map((item) => item.productId))).toEqual(new Set(changes.keys()));
  });
});
