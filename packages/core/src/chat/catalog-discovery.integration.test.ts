/**
 * Karar 0131: sohbette gercek katalogdan urun kesfi, uctan uca (model haric).
 * Sohbetin arama yolu: `SearchIntent` -> `searchByIntent` -> sozluk -> sinirli aday
 * aramasi -> gercek urunler. Model yalnizca niyeti cikarir; burada niyet dogrudan
 * verilir (istek yolunda model yok, testte de yok).
 *
 * Fixture: Turkce TRY basliklari ve Ingilizce AliExpress (yalnizca USD teklifli)
 * kaynak ilanlari + bir TASLAK ilan. Kur BILEREK yok: fiyat sistemi olmadan da urun
 * kesfi calismali, yaklasik TL uydurulmamali.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProductForeignOffers } from "../offers/product-foreign-offers.ts";
import { refreshProductAggregates } from "../product/refresh-aggregates.ts";
import { resolveProductSlug } from "../product/resolve-product-slug.ts";
import { invalidateLexiconCache } from "../search/lexicon-cache.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { SearchIntent } from "./contract.ts";
import { emptyIntent } from "./intent.ts";
import { searchByIntent } from "./search-adapter.ts";

const run = `cd-${Date.now()}`;

interface Fixture {
  key: string;
  title: string;
  merchant: "tr" | "ae";
  price: number;
  draft?: boolean;
}

const FIXTURES: Fixture[] = [
  {
    key: "t-iphone16pro256",
    title: "Apple iPhone 16 Pro 256 GB Siyah Cep Telefonu",
    merchant: "tr",
    price: 7_499_900,
  },
  {
    key: "t-iphone16promax128",
    title: "Apple iPhone 16 Pro Max 128 GB Akıllı Telefon",
    merchant: "tr",
    price: 8_199_900,
  },
  {
    key: "t-kulaklik",
    title: "JBL Tune 520BT Kablosuz Kulaklık Mavi",
    merchant: "tr",
    price: 79_900,
  },
  {
    key: "t-hoparlor",
    title: "Anker Soundcore Bluetooth Hoparlör Siyah",
    merchant: "tr",
    price: 149_900,
  },
  {
    key: "a-case16",
    title: "Shockproof Clear Case for iPhone 16 Pro Max Magnetic Cover",
    merchant: "ae",
    price: 399,
  },
  {
    key: "a-earbuds",
    title: "Wireless Bluetooth 5.3 Earbuds TWS Noise Cancelling Headphones With Mic",
    merchant: "ae",
    price: 1_299,
  },
  {
    key: "a-speaker",
    title: "Portable Wireless Bluetooth Speaker Waterproof Outdoor Bass Column",
    merchant: "ae",
    price: 2_150,
  },
  {
    key: "a-gaming",
    title: "Gaming Headset With Mic RGB Light For PC PS5 Xbox",
    merchant: "ae",
    price: 1_899,
  },
  {
    key: "a-case15",
    title: "Soft Silicone Case for iPhone 15 Candy Color",
    merchant: "ae",
    price: 199,
  },
  { key: "t-saat", title: "Garmin Venu 3 Akıllı Saat Siyah", merchant: "tr", price: 1_299_900 },
  {
    key: "a-watch",
    title: "Smart Watch Men Bluetooth Call Heart Rate Fitness Tracker",
    merchant: "ae",
    price: 1_550,
  },
  {
    key: "a-draft",
    title: "Wireless Earbuds Bluetooth Headphones Draft Listing",
    merchant: "ae",
    price: 999,
    draft: true,
  },
];

describe("sohbette katalog kesfi (karar 0131)", () => {
  let db: Database;
  const ids = new Map<string, number>();
  const merchants: Record<"tr" | "ae", number> = { tr: 0, ae: 0 };

  const intent = (query: string, patch: Partial<SearchIntent> = {}): SearchIntent => ({
    ...emptyIntent(query),
    ...patch,
  });
  const found = async (i: SearchIntent) => {
    const result = await searchByIntent(db, i, { pageSize: 24 });
    return { result, ids: result.outcome.items.map((item) => item.productId) };
  };
  const id = (key: string) => ids.get(key) as number;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      for (const key of ["tr", "ae"] as const) {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $2, $3, 'xml_feed', TRUE, 70) RETURNING id`,
          [
            `${key}-${run}`,
            key === "tr" ? `Yerli Mağaza ${run}` : `AliExpress ${run}`,
            `${key}-${run}.test`,
          ],
        );
        merchants[key] = Number(row.rows[0].id);
      }
      for (const f of FIXTURES) {
        const currency = f.merchant === "tr" ? "TRY" : "USD";
        const offer = await client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, currency,
                              is_active, in_stock, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, $7) RETURNING id`,
          [
            merchants[f.merchant],
            `${f.key}-${run}`,
            `https://${f.merchant}-${run}.test/item/${f.key}`,
            f.title,
            f.price,
            currency,
            `https://img.${f.merchant}-${run}.test/${f.key}.jpg`,
          ],
        );
        const offerId = Number(offer.rows[0].id);
        const product = await client.query(
          `INSERT INTO product (slug, title, primary_image_url, publication_state,
                                source_merchant_id, source_external_id, source_offer_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            `${f.key}-${run}`,
            f.title,
            `https://img.${f.merchant}-${run}.test/${f.key}.jpg`,
            f.draft ? "draft" : "published",
            f.merchant === "ae" ? merchants.ae : null,
            f.merchant === "ae" ? `${f.key}-${run}` : null,
            f.merchant === "ae" ? offerId : null,
          ],
        );
        const productId = Number(product.rows[0].id);
        ids.set(f.key, productId);
        // Taslak bag kurmaz (karar 0121: bag yayin aninda kurulur).
        if (!f.draft) {
          await client.query("UPDATE offer SET product_id = $1 WHERE id = $2", [
            productId,
            offerId,
          ]);
        }
      }
    });
    await refreshProductAggregates(db, { productIds: [...ids.values()] });
    invalidateLexiconCache(db);
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      // product.source_offer_id teklifi gosterir: once bag kopar, sonra teklif ve urun.
      await client.query("UPDATE product SET source_offer_id = NULL WHERE id = ANY($1)", [
        [...ids.values()],
      ]);
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [
        Object.values(merchants),
      ]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [[...ids.values()]]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [Object.values(merchants)]);
    });
  });

  it("1 + 6 + 10: kablosuz kulaklik -> gercek TRY urunu VE yalnizca USD teklifli AliExpress ilani", async () => {
    const { result, ids: got } = await found(intent("kablosuz kulaklık"));
    expect(got).toContain(id("t-kulaklik"));
    expect(got).toContain(id("a-earbuds"));
    expect(got).not.toContain(id("t-iphone16pro256"));
    const earbuds = result.outcome.items.find((item) => item.productId === id("a-earbuds"));
    expect(earbuds?.merchantName).toBe(`AliExpress ${run}`);
    expect(earbuds?.foreignPrice?.currency).toBe("USD");
  });

  it("2: iPhone 16 kilifi telefonun kendisini onermez; dogru model once", async () => {
    const { ids: got } = await found(intent("iphone 16 kılıfı"));
    expect(got).toContain(id("a-case16"));
    expect(got).not.toContain(id("t-iphone16pro256"));
    expect(got).not.toContain(id("t-iphone16promax128"));
    if (got.includes(id("a-case15"))) {
      expect(got.indexOf(id("a-case16"))).toBeLessThan(got.indexOf(id("a-case15")));
    }
  });

  it("model ve kapasite: iphone 16 pro 256 gb -> 256 GB modeli, kilif degil", async () => {
    const { ids: got } = await found(intent("iphone 16 pro 256 gb"));
    expect(got[0]).toBe(id("t-iphone16pro256"));
    expect(got).not.toContain(id("a-case16"));
  });

  it("bluetooth hoparlor: Turkce sorgu Ingilizce 'Speaker' basligini bulur", async () => {
    const { ids: got } = await found(intent("bluetooth hoparlör"));
    expect(got).toContain(id("t-hoparlor"));
    expect(got).toContain(id("a-speaker"));
    expect(got).not.toContain(id("a-earbuds"));
  });

  it("cok kelimeli esanlam: akilli saat -> Turkce 'Akıllı Saat' VE Ingilizce 'Smart Watch'; TRY once", async () => {
    const { ids: got } = await found(intent("akıllı saat"));
    expect(got).toContain(id("t-saat"));
    expect(got).toContain(id("a-watch"));
    expect(got.indexOf(id("t-saat"))).toBeLessThan(got.indexOf(id("a-watch")));
  });

  it("oyuncu kulakligi -> gaming headset", async () => {
    const { ids: got } = await found(intent("oyuncu kulaklığı"));
    expect(got).toContain(id("a-gaming"));
  });

  it("3 + 4: kart verisi gercek kayittan: baslik, gorsel, slug (detay baglantisi)", async () => {
    const { result } = await found(intent("bluetooth hoparlör"));
    const speaker = result.outcome.items.find((item) => item.productId === id("a-speaker"));
    expect(speaker?.title).toBe(FIXTURES.find((f) => f.key === "a-speaker")?.title);
    expect(speaker?.primaryImageUrl).toBe(`https://img.ae-${run}.test/a-speaker.jpg`);
    expect(speaker?.slug).toBe(`a-speaker-${run}`);
  });

  it("4: detay baglantisi acilir (yayindaki USD urun) ve yurt disi teklif sayfada; taslak 404", async () => {
    const page = await resolveProductSlug(db, `a-speaker-${run}`);
    expect(page.status).toBe("found");
    const offers = await getProductForeignOffers(db, id("a-speaker"));
    expect(offers.map((o) => o.currency)).toContain("USD");
    expect((await resolveProductSlug(db, `a-draft-${run}`)).status).toBe("not_found");
  });

  it("5: karsiligi olmayan istek sahte sonuc uretmez", async () => {
    const { result } = await found(intent("zqxvbnm plorktrav"));
    expect(result.outcome.items).toHaveLength(0);
    expect(result.outcome.mode).toBe("empty");
  });

  it("7: fiyat sistemi olmadan oneri calisir; kur yoksa yaklasik TL uydurulmaz", async () => {
    const { result } = await found(intent("bluetooth hoparlör"));
    const speaker = result.outcome.items.find((item) => item.productId === id("a-speaker"));
    expect(speaker).toBeDefined();
    if (speaker?.foreignPrice?.fxDate === null) expect(speaker.minPrice).toBeNull();
  });

  it("fiyat araligi: TL fiyati bilinmeyen urun suzgecten gecmis gibi gosterilmez", async () => {
    const { ids: got, result } = await found(intent("kablosuz kulaklık", { priceMax: 1_000 }));
    expect(got).toContain(id("t-kulaklik"));
    for (const item of result.outcome.items) {
      expect(item.minPrice).not.toBeNull();
      expect(item.minPrice as number).toBeLessThanOrEqual(100_000);
    }
  });

  it("9: taslak ilan sohbette hic onerilmez", async () => {
    for (const q of ["kablosuz kulaklık", "wireless earbuds", "draft listing earbuds"]) {
      const { ids: got } = await found(intent(q));
      expect(got).not.toContain(id("a-draft"));
    }
  });
});
