import { describe, expect, it } from "vitest";
import { externalIdFromUrl, extractHepsiburadaPage } from "./extract-hepsiburada.ts";
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
