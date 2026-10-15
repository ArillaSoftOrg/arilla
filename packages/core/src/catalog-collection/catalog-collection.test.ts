import { describe, expect, it } from "vitest";
import { externalIdFromUrl, extractHepsiburadaPage } from "./extract-hepsiburada.ts";
import { extractHepsiburadaProductPage } from "./extract-product-page.ts";
import { validateIntakeRecord } from "./validate.ts";

// Sentetik sayfa: gercek Hepsiburada verisi DEGILDIR; yalnizca arsivlenen yapiyi sinar.
function page(items: unknown[]): string {
  const itemListElement = JSON.stringify(items);
  const store = {
    voltranState: { fragmentsMap: { a: { ProductList: { seoState: { itemListElement } } } } },
  };
  return `<html><script id="reduxStore">${JSON.stringify(store)}</script></html>`;
}

const item = (over: Record<string, unknown> = {}) => ({
  name: "Test Telefon 128 GB",
  url: "https://www.hepsiburada.com/test-telefon-p-HBCV00001?magaza=x",
  image: ["https://productimages.hepsiburada.net/s/1/500/a.jpg"],
  offers: { price: "1299.90", priceCurrency: "TRY", availability: "https://schema.org/InStock" },
  ...over,
});

describe("extractHepsiburadaPage", () => {
  it("kimlik, fiyat (kurus), gorsel ve stok cikarir; sorgu parcasini atar", () => {
    const r = extractHepsiburadaPage(page([item()]));
    expect(r.structureFound).toBe(true);
    expect(r.items).toEqual([
      {
        externalId: "HBCV00001",
        title: "Test Telefon 128 GB",
        url: "https://www.hepsiburada.com/test-telefon-p-HBCV00001",
        priceMinor: 129990,
        currency: "TRY",
        inStock: true,
        imageUrl: "https://productimages.hepsiburada.net/s/1/500/a.jpg",
        brand: null,
      },
    ]);
  });

  it("listede olmayan alani uydurmaz (marka yok, stok bilinmiyor)", () => {
    const r = extractHepsiburadaPage(page([item({ offers: { price: 10, priceCurrency: "TRY" } })]));
    expect(r.items[0]?.brand).toBeNull();
    expect(r.items[0]?.inStock).toBeNull();
  });

  it("gecersiz ogeleri eler ama ham sayiyi bildirir", () => {
    const r = extractHepsiburadaPage(
      page([
        item(),
        item({ url: "https://evil.example/x-p-HBCV00002" }),
        item({ offers: { price: "5", priceCurrency: "USD" } }),
        item({ url: "https://www.hepsiburada.com/kodsuz-urun" }),
        item({ name: "" }),
      ]),
    );
    expect(r.rawCount).toBe(5);
    expect(r.items).toHaveLength(1);
  });

  it("engel/yapi degisimi sayfasini yapi bulunamadi olarak bildirir", () => {
    expect(extractHepsiburadaPage("<html>Dogrulama</html>").structureFound).toBe(false);
    expect(extractHepsiburadaPage('<script id="reduxStore">{bozuk</script>').structureFound).toBe(
      false,
    );
  });

  it("fiyat tam metinle kurusa cevrilir; 2'den fazla ondalik, virgul ve bilimsel gosterim elenir", () => {
    const price = (p: unknown) =>
      extractHepsiburadaPage(page([item({ offers: { price: p, priceCurrency: "TRY" } })])).items[0]
        ?.priceMinor ?? null;
    expect(price("1299.9")).toBe(129990);
    expect(price(289)).toBe(28900);
    expect(price("129.99")).toBe(12999);
    expect(price("130000.00")).toBe(13000000);
    expect(price("1.005")).toBeNull();
    expect(price("5,50")).toBeNull();
    expect(price("1e3")).toBeNull();
    expect(price("0")).toBeNull();
    expect(price(-5)).toBeNull();
    expect(price(null)).toBeNull();
  });

  it("URL'den urun kodu", () => {
    expect(externalIdFromUrl("https://www.hepsiburada.com/a-b-pm-ABC123")).toBe("ABC123");
    expect(externalIdFromUrl("https://www.hepsiburada.com/a-b")).toBeNull();
  });
});

describe("validateIntakeRecord", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const rules = {
    urlHost: "hepsiburada.com",
    imageHost: "hepsiburada.net",
    now,
    runStart: new Date("2026-10-20T11:00:00Z"),
  };
  const good = () => ({
    externalId: "HBCV00001",
    title: "Urun",
    url: "https://www.hepsiburada.com/u-p-HBCV00001?x=1",
    priceMinor: 12999,
    currency: "TRY",
    sourceObservedAt: "2026-10-20T11:30:00Z",
    imageUrl: "https://productimages.hepsiburada.net/a.jpg",
  });

  it("gecerli kaydi kabul eder, sorguyu atar, liste fiyatini satistan buyukse tutar", () => {
    const r = validateIntakeRecord({ ...good(), listPriceMinor: 15000 }, rules);
    expect(r.ok && r.record.url).toBe("https://www.hepsiburada.com/u-p-HBCV00001");
    expect(r.ok && r.record.listPriceMinor).toBe(15000);
    const same = validateIntakeRecord({ ...good(), listPriceMinor: 12999 }, rules);
    expect(same.ok && same.record.listPriceMinor).toBeNull();
  });

  it.each([
    [{ priceMinor: 12.5 }, "price"],
    [{ priceMinor: 0 }, "price"],
    [{ priceMinor: 10 ** 12 }, "price"],
    [{ currency: "USD" }, "currency"],
    [{ url: "http://www.hepsiburada.com/u-p-X1" }, "url"],
    [{ url: "https://hepsiburada.com.evil.example/u" }, "url"],
    [{ url: "https://user:pw@www.hepsiburada.com/u" }, "url"],
    [{ imageUrl: "https://evil.example/a.jpg" }, "image_url"],
    [{ externalId: "../x" }, "external_id"],
    [{ title: "  " }, "title"],
    [{ gtin: "abc" }, "gtin"],
    [{ sourceObservedAt: "2026-10-19T00:00:00Z" }, "observed_at"],
    [{ sourceObservedAt: "2026-10-21T00:00:00Z" }, "observed_at"],
    [{ sourceObservedAt: "dun" }, "observed_at"],
  ])("reddeder %j -> %s", (over, code) => {
    const r = validateIntakeRecord({ ...good(), ...over }, rules);
    expect(r).toEqual({ ok: false, code });
  });

  it("nesne olmayan girdiyi reddeder", () => {
    expect(validateIntakeRecord("x", rules)).toEqual({ ok: false, code: "not_object" });
    expect(validateIntakeRecord(null, rules)).toEqual({ ok: false, code: "not_object" });
  });
});

describe("extractHepsiburadaProductPage (dogrulanmamis; standart JSON-LD)", () => {
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  it("ana satici, varyant etiketi ve gecerli GTIN'i okur", () => {
    const r = extractHepsiburadaProductPage(
      ld({
        "@type": "Product",
        color: "Siyah",
        size: "42",
        gtin13: "8690000000015",
        offers: { price: "1", seller: { "@type": "Organization", name: "Ornek Magaza" } },
      }),
    );
    expect(r).toEqual({
      sellerName: "Ornek Magaza",
      variantLabel: "Siyah / 42",
      gtin: "8690000000015",
    });
  });
  it("bulunmayani uydurmaz; uydurma GTIN'i reddeder", () => {
    expect(extractHepsiburadaProductPage("<html></html>")).toEqual({
      sellerName: null,
      variantLabel: null,
      gtin: null,
    });
    const r = extractHepsiburadaProductPage(ld({ "@type": "Product", gtin: "0000000000000" }));
    expect(r.gtin).toBeNull();
    expect(r.sellerName).toBeNull();
  });
});
