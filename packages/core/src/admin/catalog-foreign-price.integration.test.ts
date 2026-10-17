/**
 * Yurt dışı (USD) teklifli ürünün fiyat özeti ve yönetim paneli (karar 0127).
 *
 * Üretim hatası: yayınlanan 10 AliExpress ürünü yönetimde "Fiyatsız", "Aktif
 * mağazası yok" ve "Fiyat özeti 7+ gündür yenilenmedi" görünüyordu. Özet yalnızca
 * TRY teklif sayıyordu; USD-only ürünün özeti varsayılanla aynı kaldığı için satır
 * hiç yazılmıyor, `price_updated_at` NULL kalıyordu. Fiyatlar TRY-only kalır; USD
 * tutar TL'ye çevrilmez, kendi para birimiyle gösterilir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProductForeignOffers } from "../offers/product-foreign-offers.ts";
import { refreshProductAggregates } from "../product/refresh-aggregates.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { AdminActor } from "./capabilities.ts";
import { countProductQuality, getProductDetail, listOffers, searchProducts } from "./catalog.ts";

describe("yurt dışı teklifli ürün fiyat özeti ve yönetim - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let moderator: AdminActor;
  let userId = 0;
  const merchants = { ali: 0, closed: 0, tr: 0 };
  // usd: yalnız USD; mixed: TRY + USD; closed: USD ama mağaza kapalı.
  const products = { usd: 0, mixed: 0, closed: 0 };
  let unmatchedUsdOfferId = 0;
  let fxRateId = 0;

  const summary = (id: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT min_price::int AS min_price, offer_count, in_stock_count, foreign_offer_count,
                price_updated_at
           FROM product WHERE id = $1`,
        [id],
      );
      return res.rows[0];
    });

  const filtered = async (id: number, quality: "no_offers" | "no_price" | "foreign_only") =>
    (await searchProducts(db, moderator, { query: String(id), quality })).rows.map((r) => r.id);

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`fx-mod-${suffix}@test.local`],
      );
      userId = Number(user.rows[0].id);
      moderator = { userId, role: "moderator" };

      for (const [key, active] of [
        ["ali", true],
        ["closed", false],
        ["tr", true],
      ] as const) {
        const res = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $2, $3, 'xml_feed', $4) RETURNING id`,
          [`fx-${key}-${suffix}`, `Fx ${key}`, `fx-${key}-${suffix}.test`, active],
        );
        merchants[key] = Number(res.rows[0].id);
      }
      for (const key of ["usd", "mixed", "closed"] as const) {
        const res = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`fx-${key}-${suffix}`, `Fx urun ${key}`],
        );
        products[key] = Number(res.rows[0].id);
      }
      const offer = (
        merchantId: number,
        productId: number | null,
        sku: string,
        price: number,
        currency: string,
      ) =>
        client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, list_price, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            merchantId,
            productId,
            sku,
            `https://fx-${suffix}.test/${sku}`,
            `Fx teklif ${sku}`,
            price,
            price + 500,
            currency,
          ],
        );
      // 19,99 USD: kuruş gibi okunursa "19,99 TL" görünürdü.
      await offer(merchants.ali, products.usd, "u-1", 1999, "USD");
      await offer(merchants.ali, products.mixed, "m-usd", 2500, "USD");
      await offer(merchants.tr, products.mixed, "m-try", 150000, "TRY");
      await offer(merchants.closed, products.closed, "c-1", 999, "USD");
      const unmatched = await offer(merchants.ali, null, "x-1", 4200, "USD");
      unmatchedUsdOfferId = Number(unmatched.rows[0].id);
      // Testin kendi kuru: gelecekteki bir bülten, `now` ile 1 gün sonrası (başka satırla çakışmaz).
      const fx = await client.query(
        `INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
         VALUES ('tcmb', 'USD', 'TRY', 41.50000000, 'forex_selling', '2031-01-02', 'test')
         RETURNING id`,
      );
      fxRateId = Number(fx.rows[0].id);
    });
    await refreshProductAggregates(db, { productIds: Object.values(products) });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM fx_rate WHERE id = $1", [fxRateId]);
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [
        Object.values(merchants),
      ]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [Object.values(products)]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [Object.values(merchants)]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
  });

  it("USD-only ürünün özeti yazılır: TRY fiyat yok, yurt dışı mağaza 1, özet zamanı dolu", async () => {
    const row = await summary(products.usd);
    expect(row).toMatchObject({
      min_price: null,
      offer_count: 0,
      in_stock_count: 0,
      foreign_offer_count: 1,
    });
    expect(row.price_updated_at).not.toBeNull();
  });

  it("karışık ürün: TL özeti yalnız TRY teklifinden, USD ayrı sayılır", async () => {
    expect(await summary(products.mixed)).toMatchObject({
      min_price: 150000,
      offer_count: 1,
      foreign_offer_count: 1,
    });
  });

  it("kapalı mağazanın USD teklifi sayılmaz (aktif mağaza kuralı)", async () => {
    expect(await summary(products.closed)).toMatchObject({
      offer_count: 0,
      foreign_offer_count: 0,
    });
  });

  it("tekrar çalıştırmak satır yazmaz (idempotent)", async () => {
    expect(await refreshProductAggregates(db, { productIds: Object.values(products) })).toBe(0);
  });

  it("yönetim filtreleri: USD ürün fiyatsız/mağazasız değil, 'yalnız yurt dışı fiyatlı'", async () => {
    expect(await filtered(products.usd, "no_price")).toEqual([]);
    expect(await filtered(products.usd, "no_offers")).toEqual([]);
    expect(await filtered(products.usd, "foreign_only")).toEqual([products.usd]);
    expect(await filtered(products.mixed, "foreign_only")).toEqual([]);
    // Kapalı mağaza: gerçekten aktif mağazası ve fiyatı yok.
    expect(await filtered(products.closed, "no_offers")).toEqual([products.closed]);
    expect(await filtered(products.closed, "no_price")).toEqual([products.closed]);

    const counts = await countProductQuality(db, moderator);
    expect(counts.foreign_only).toBeGreaterThanOrEqual(1);
    expect(counts.no_price).toBeLessThanOrEqual(counts.total);
  });

  it("ürün listesi USD fiyatı kendi para birimiyle verir, TL kolonuna yazmaz", async () => {
    const [usd] = (await searchProducts(db, moderator, { query: String(products.usd) })).rows;
    expect(usd).toMatchObject({
      minPrice: null,
      offerCount: 0,
      foreignOfferCount: 1,
      foreignPrices: [{ currency: "USD", minPrice: 1999 }],
    });
    expect(usd?.priceUpdatedAt).toBeInstanceOf(Date);
    const [mixed] = (await searchProducts(db, moderator, { query: String(products.mixed) })).rows;
    expect(mixed).toMatchObject({
      minPrice: 150000,
      foreignPrices: [{ currency: "USD", minPrice: 2500 }],
    });
    const [closed] = (await searchProducts(db, moderator, { query: String(products.closed) })).rows;
    expect(closed?.foreignPrices).toEqual([]);
  });

  it("ürün detayı ve teklif listesi para birimini taşır", async () => {
    const detail = await getProductDetail(db, moderator, products.usd);
    expect(detail?.product.foreignPrices).toEqual([{ currency: "USD", minPrice: 1999 }]);
    expect(detail?.offers.map((o) => [o.currency, o.price, o.listPrice])).toEqual([
      ["USD", 1999, 2499],
    ]);
    const offers = await listOffers(db, moderator, { query: `#${unmatchedUsdOfferId}` });
    expect(offers.rows.map((o) => [o.currency, o.price])).toEqual([["USD", 4200]]);
  });

  it("ürün sayfası: USD tutar değişmez; kur varsa yaklaşık TL, yoksa TL verilmez", async () => {
    const withRate = await getProductForeignOffers(
      db,
      products.usd,
      new Date("2031-01-03T09:00:00Z"),
    );
    expect(withRate).toHaveLength(1);
    expect(withRate[0]).toMatchObject({
      merchantName: "Fx ali",
      currency: "USD",
      priceMinor: 1999,
      listPriceMinor: 2499,
    });
    // 19,99 USD x 41,5 = 829,585 TL -> 82.959 kuruş (yarım yukarı).
    expect(withRate[0]?.approx).toMatchObject({
      approxTryMinor: 82959,
      originalMinor: 1999,
      currency: "USD",
      quote: { effectiveDate: "2031-01-02" },
    });

    // Kur 4 günden eski: dönüşüm yok, USD fiyat yine gösterilir.
    const stale = await getProductForeignOffers(db, products.usd, new Date("2031-01-10T09:00:00Z"));
    expect(stale[0]).toMatchObject({ currency: "USD", priceMinor: 1999, approx: null });

    // Kapalı mağaza ürün sayfasında da görünmez.
    expect(await getProductForeignOffers(db, products.closed)).toEqual([]);
  });
});
