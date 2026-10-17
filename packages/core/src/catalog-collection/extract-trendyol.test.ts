import { describe, expect, it } from "vitest";
import {
  canonicalTrendyolProductUrl,
  collectTrendyolPageInputs,
  extractTrendyolPage,
  type TrendyolPageInputs,
  trendyolInputsFromHtml,
} from "./extract-trendyol.ts";
import iphone from "./fixtures/iphone-857296094.json";
import listing from "./fixtures/listing-cat1.json";
import samba from "./fixtures/samba-813659620.json";
import { validateIntakeRecord } from "./validate.ts";

const input = (fx: {
  url: string;
  observedAt: string;
  scriptTexts: string[];
  jsonLdTexts: string[];
}): TrendyolPageInputs => ({ ...fx });

describe("urun sayfasi (kayitli gercek ornek: iPhone 16 Pro)", () => {
  const page = extractTrendyolPage(input(iphone));
  const item = page.items[0];

  it("istenen alanlar: kimlik, ad, satis fiyati, gorseller, kanonik adres, ana satici, kaynak zamani", () => {
    expect(page.kind).toBe("product_page");
    expect(page.unitKey).toBe("857296094");
    expect(page.structureFound).toBe(true);
    expect(item).toMatchObject({
      externalId: "857296094",
      title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
      url: "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
      priceMinor: 12_499_900,
      listPriceMinor: 12_799_900,
      basketPriceMinor: null,
      currency: "TRY",
      sellerExternalId: "724838",
      sellerName: "Akarsu İletişim Teknoloji Ürünleri",
      groupExternalId: "653969108",
      // Tek varyant: fiyat ayrimi gerekmez.
      variantExternalId: null,
      variantLabel: null,
      sourcePage: "product_page",
      sourceObservedAt: "2026-10-12T01:19:00Z",
    });
    expect(item?.imageUrls.length).toBeGreaterThan(0);
    expect(item?.imageUrl).toBe(item?.imageUrls[0]);
  });

  it("istenmeyenler yok: stok, diger saticilar, saticinin kisisel/kurumsal bilgisi", () => {
    const json = JSON.stringify(page);
    expect(json).not.toContain("REDACTED");
    expect(json).not.toMatch(/inStock|stock|otherMerchant|taxNumber|address/i);
  });
});

describe("urun sayfasi: sepet indirimi satis fiyatiyla karistirilmaz (Samba, gozlenen alanlar)", () => {
  const item = extractTrendyolPage(input(samba)).items[0];

  it("satis fiyati 7.999; sepette 3.999,50 ayri ve kosullu; JSON-LD fiyati (3.999,50) kullanilmaz", () => {
    expect(item?.priceMinor).toBe(799_900);
    expect(item?.basketPriceMinor).toBe(399_950);
    // Ustu cizili 5.599,30 satis fiyatindan dusuk: liste fiyati sayilmaz.
    expect(item?.listPriceMinor).toBeNull();
  });

  it("cok bedenli: fiyatin ait oldugu ana satici varyanti tasinir", () => {
    expect(item?.variantExternalId).toBe("1084850373");
    expect(item?.variantLabel).toBe("38");
    expect(item?.sellerExternalId).toBe("106871");
  });
});

describe("liste sayfasi (kayitli gercek kartlar)", () => {
  const page = extractTrendyolPage(input(listing));

  it("satis fiyati `current`; sepet promosyonu ayri; normal kartta sepet fiyati yok", () => {
    expect(page.kind).toBe("listing_page");
    expect(page.unitKey).toBe("/apple-cep-telefonu-x-b101470-c103498");
    expect(page.rawCount).toBe(2);
    const [basket, plain] = page.items;
    expect(basket).toMatchObject({
      externalId: "1198082362",
      priceMinor: 19_389_900,
      basketPriceMinor: 19_385_900,
      listPriceMinor: 19_780_900,
      sellerName: null,
      sourcePage: "listing_page",
    });
    expect(basket?.url).toBe(
      "https://www.trendyol.com/apple/iphone-18-pro-max-512gb-burgundy-p-1198082362",
    );
    expect(plain).toMatchObject({
      externalId: "762254881",
      priceMinor: 5_899_900,
      basketPriceMinor: null,
      listPriceMinor: null,
      sellerExternalId: "968",
      variantExternalId: null,
    });
  });
});

describe("dogrulanamayan veri uydurulmaz", () => {
  const base = { url: "https://www.trendyol.com/x/y-p-1", observedAt: "2026-10-15T00:00:00Z" };

  it("satis fiyati yoksa kayit uretilmez (JSON-LD fiyati yedek DEGIL)", () => {
    const page = extractTrendyolPage({
      ...base,
      scriptTexts: [
        'window["__envoy__SHARED_PROPS"]={"product":{"id":1,"name":"Y","brand":{"name":"X"},"merchantListing":{"winnerVariant":{"price":{"currency":"TRY","discountedPrice":{"value":10}}}}}}',
      ],
      jsonLdTexts: [
        JSON.stringify({
          "@type": "Product",
          name: "X Y",
          offers: { price: "10", priceCurrency: "TRY" },
        }),
      ],
    });
    expect(page.items).toEqual([]);
    expect(page.dropped).toEqual({ price_unverified: 1 });
  });

  it("gomulu veri adresteki urune ait degilse (sayfa ici gezinme) kayit yok", () => {
    const page = extractTrendyolPage({
      ...input(iphone),
      url: "https://www.trendyol.com/apple/iphone-16-pro-128gb-siyah-titanyum-p-857296083",
    });
    expect(page.items).toEqual([]);
    expect(page.dropped).toEqual({ stale_embedded_data: 1 });
  });

  it("TRY disi para birimi reddedilir; trendyol.com disi sayfa okunmaz; engel sayfasi yapisiz", () => {
    const usd = extractTrendyolPage({
      ...base,
      scriptTexts: [
        'window["__envoy__SHARED_PROPS"]={"product":{"id":1,"name":"Y","merchantListing":{"winnerVariant":{"price":{"currency":"USD","sellingPrice":{"value":10}}}}}}',
      ],
      jsonLdTexts: [],
    });
    expect(usd.dropped).toEqual({ not_try: 1 });
    expect(
      extractTrendyolPage({
        ...base,
        url: "https://evil.example/x/y-p-1",
        scriptTexts: [],
        jsonLdTexts: [],
      }).kind,
    ).toBe("unknown");
    const blocked = extractTrendyolPage({
      ...base,
      scriptTexts: ["<html>challenge</html>"],
      jsonLdTexts: [],
    });
    expect(blocked.structureFound).toBe(false);
    expect(blocked.items).toEqual([]);
  });

  it("kanonik adres: sorgu/parca atilir, baska host ve -p- disi yol reddedilir", () => {
    expect(canonicalTrendyolProductUrl("/a/b-p-12?merchantId=1#x")).toBe(
      "https://www.trendyol.com/a/b-p-12",
    );
    expect(canonicalTrendyolProductUrl("https://m.trendyol.com/a/b-p-12")).toBeNull();
    expect(canonicalTrendyolProductUrl("/a/b-x-c12")).toBeNull();
  });
});

describe("girdi toplama: DOM ve kayitli HTML ayni sonucu verir", () => {
  it("icerik betigi yalnizca script metinlerini okur", () => {
    const html = `<script type="application/ld+json">${iphone.jsonLdTexts[0]}</script><script>${iphone.scriptTexts[0]}</script>`;
    const a = extractTrendyolPage(trendyolInputsFromHtml(html, iphone.url, iphone.observedAt));
    const doc = {
      querySelectorAll: () => [
        { type: "application/ld+json", textContent: iphone.jsonLdTexts[0] as string },
        { type: "", textContent: iphone.scriptTexts[0] as string },
      ],
    };
    const b = extractTrendyolPage(collectTrendyolPageInputs(doc, iphone.url, iphone.observedAt));
    expect(a.items).toEqual(b.items);
    expect(a.items).toHaveLength(1);
  });
});

describe("sunucu dogrulamasi (Trendyol kurallari)", () => {
  const rules = {
    urlHost: "trendyol.com",
    imageHost: "dsmcdn.com",
    externalIdPattern: /^[0-9]{1,20}$/,
    canonicalUrl: (url: string, id: string) => new URL(url).pathname.endsWith(`-p-${id}`),
    extended: true,
    now: new Date("2026-10-12T02:00:00Z"),
    runStart: new Date("2026-10-12T00:00:00Z"),
  };

  it("cikarilan kayit sunucuda aynen gecer; ek alanlar korunur", () => {
    const item = extractTrendyolPage(input(samba)).items[0];
    const r = validateIntakeRecord({ ...item, sourceObservedAt: "2026-10-12T01:00:00Z" }, rules);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record).toMatchObject({
        externalId: "813659620",
        priceMinor: 799_900,
        basketPriceMinor: 399_950,
        variantExternalId: "1084850373",
        sellerName: "SuperStep",
        sourcePage: "product_page",
      });
    }
  });

  it("adres kimlikle tutarsizsa, gorsel baska hostta ya da sepet fiyati satis fiyatindan buyukse reddedilir/atilir", () => {
    const item = extractTrendyolPage(input(iphone)).items[0];
    const at = { sourceObservedAt: "2026-10-12T01:00:00Z" };
    expect(validateIntakeRecord({ ...item, ...at, externalId: "1" }, rules)).toEqual({
      ok: false,
      code: "url",
    });
    expect(
      validateIntakeRecord({ ...item, ...at, imageUrls: ["https://evil.example/a.jpg"] }, rules),
    ).toEqual({ ok: false, code: "image_urls" });
    const r = validateIntakeRecord({ ...item, ...at, basketPriceMinor: 99_999_999 }, rules);
    expect(r.ok && r.record.basketPriceMinor).toBeNull();
  });
});
