import { describe, expect, it } from "vitest";
import { catalogRowsFromObservation } from "./catalog-rows.ts";
import { bulkRefreshGate, isTrendyolBrowserReadEnabled } from "./config.ts";
import iphone from "./fixtures/iphone-857296094.json";
import samba from "./fixtures/samba-813659620.json";
import { collectPageInputs, type PageInputs, pageInputsFromHtml } from "./page-inputs.ts";
import {
  canStartCycle,
  emptyLedger,
  expireStale,
  istanbulMonthKey,
  recordItem,
  replaceCycle,
  resumeCycle,
  startCycle,
} from "./refresh-quota.ts";
import { extractSearchPage } from "./search-page.ts";
import { hasId, matchToSitemap } from "./sitemap-match.ts";
import { amountToKurus, extractTrendyolProductPage, gtin14 } from "./trendyol-product-page.ts";

const asInput = (fx: {
  url: string;
  observedAt: string;
  scriptTexts: string[];
  jsonLdTexts: string[];
}): PageInputs => ({
  url: fx.url,
  observedAt: fx.observedAt,
  scriptTexts: fx.scriptTexts,
  jsonLdTexts: fx.jsonLdTexts,
});

describe("bayraklar", () => {
  it("varsayilan kapali; toplu yenileme yazili kapsam onayi ister", () => {
    expect(isTrendyolBrowserReadEnabled({})).toBe(false);
    expect(bulkRefreshGate({})).toEqual({ allowed: false, reason: "read_disabled" });
    expect(bulkRefreshGate({ TRENDYOL_BROWSER_READ_ENABLED: "true" })).toEqual({
      allowed: false,
      reason: "scope_not_confirmed",
    });
    expect(
      bulkRefreshGate({
        TRENDYOL_BROWSER_READ_ENABLED: "true",
        TRENDYOL_BROWSER_SCOPE_CONFIRMED: "true",
      }),
    ).toEqual({ allowed: true });
  });
});

describe("urun sayfasi: kayitli gercek ornek (iPhone 16 Pro, tek varyant)", () => {
  const obs = extractTrendyolProductPage(asInput(iphone));

  it("ad, gorsel, kanonik adres, kimlikler", () => {
    expect(obs.source).toBe("ssr-shared-props");
    expect(obs.title).toBe("Apple iPhone 16 Pro 128GB Çöl Titanyum");
    expect(obs.brand).toBe("Apple");
    expect(obs.url).toBe(
      "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
    );
    expect(obs.contentId).toBe("857296094");
    expect(obs.groupId).toBe("653969108");
    expect(obs.images[0]).toMatch(/^https:\/\/cdn\.dsmcdn\.com\//);
  });

  it("satici yalnizca id + ad; vergi/adres/e-posta okunmaz", () => {
    expect(obs.seller).toEqual({ id: "724838", name: "Akarsu İletişim Teknoloji Ürünleri" });
    expect(JSON.stringify(obs)).not.toContain("REDACTED");
  });

  it("fiyat katmanlari kurus tamsayi; JSON-LD ile tutarli", () => {
    expect(obs.offer?.prices.discounted).toBe(12_499_900);
    expect(obs.offer?.prices.original).toBe(12_799_900);
    expect(obs.offer?.currency).toBe("TRY");
    expect(obs.jsonLd?.priceKurus).toBe(12_499_900);
    expect(obs.jsonLdMatchesDiscounted).toBe(true);
  });

  it("stok, barkod (GS1 gecerli), varyant, diger satici sayisi", () => {
    expect(obs.offer?.inStock).toBe(true);
    expect(obs.offer?.runningOutQuantity).toBe(1);
    expect(obs.offer?.barcode).toBe("195949771569");
    expect(obs.offer?.gtin14).toBe("00195949771569");
    expect(obs.variants).toHaveLength(1);
    expect(obs.variants[0]?.priceKurus).toBe(12_499_900);
    expect(obs.otherMerchantCount).toBe(0);
    expect(obs.missing).toEqual([]);
  });
});

describe("urun sayfasi: gozlenen alanlardan kurulan ornek (Samba, bedenli, kampanyali)", () => {
  const obs = extractTrendyolProductPage(asInput(samba));

  it("sepet indirimli 'odenecek' fiyat ile satis/liste fiyati ayri tutulur", () => {
    expect(obs.offer?.prices).toEqual({
      discounted: 399_950,
      selling: 799_900,
      original: 559_930,
      couponApplicable: 399_950,
      afterNoLimitPromotions: 399_950,
    });
    expect(obs.offer?.discountPercent).toBe(50);
    expect(obs.offer?.tags).toContain("kirmizi_kampanya_urunu");
    expect(obs.jsonLdMatchesDiscounted).toBe(true);
  });

  it("beden varyantlari kendi barkod ve fiyatiyla; renk kardesi ayri contentId", () => {
    expect(obs.variants.map((v) => [v.label, v.barcode, v.priceKurus])).toEqual([
      ["36", "4066765863348", 537_400],
      ["36,5", "4066765863451", 639_920],
    ]);
    expect(obs.jsonLd?.type).toBe("ProductGroup");
    expect(obs.jsonLd?.groupSiblings).toEqual([{ contentId: "1055270416", priceKurus: 519_900 }]);
    expect(obs.otherMerchantCount).toBe(5);
  });
});

describe("urun sayfasi: eksik/bozuk veri uydurulmaz", () => {
  const base = { url: "https://www.trendyol.com/x/y-p-1", observedAt: "2026-10-15T00:00:00Z" };

  it("hic veri yok", () => {
    const obs = extractTrendyolProductPage({ ...base, scriptTexts: [], jsonLdTexts: [] });
    expect(obs.offer).toBeNull();
    expect(obs.seller).toBeNull();
    expect(obs.missing).toEqual(
      expect.arrayContaining(["title", "price", "image", "seller", "stock"]),
    );
  });

  it("gomulu veri adresteki urune ait degilse (sayfa ici gezinme) gozlem kullanilmaz", () => {
    const obs = extractTrendyolProductPage({
      ...asInput(iphone),
      url: "https://www.trendyol.com/apple/iphone-16-pro-128gb-siyah-titanyum-p-857296083",
    });
    expect(obs.staleEmbeddedData).toBe(true);
    expect(obs.offer).toBeNull();
    expect(obs.title).toBeNull();
    const rows = catalogRowsFromObservation(obs, { status: "no_content_id" });
    expect(rows.offer).toBeNull();
    expect(rows.skipped).toContain("stale_embedded_data");
  });

  it("iPhone: tek varyant kazanan saticinin listesinde; teklife baglanir", () => {
    const obs = extractTrendyolProductPage(asInput(iphone));
    expect(obs.variants[0]?.sellerScoped).toBe(true);
    const rows = catalogRowsFromObservation(obs, { status: "no_content_id" });
    expect(rows.variants).toEqual([
      {
        external_id: "1159894619",
        size_label: null,
        in_stock: true,
        price_override: null,
        gtin: "00195949771569",
      },
    ]);
    expect(rows.unattributedVariants).toBe(0);
  });

  it("bozuk gomulu JSON ve TRY disi JSON-LD fiyati yok sayilir", () => {
    const obs = extractTrendyolProductPage({
      ...base,
      scriptTexts: ['window["__envoy__SHARED_PROPS"]={"product":{bozuk'],
      jsonLdTexts: [
        JSON.stringify({
          "@type": "Product",
          name: "X",
          offers: { price: "10", priceCurrency: "USD" },
        }),
      ],
    });
    expect(obs.source).toBe("json-ld-only");
    expect(obs.jsonLd?.priceKurus).toBeNull();
    expect(obs.missing).toContain("price");
  });

  it("trendyol.com disi adres kanonik sayilmaz", () => {
    const obs = extractTrendyolProductPage({
      ...base,
      url: "https://evil.example/x/y-p-1",
      scriptTexts: [],
      jsonLdTexts: [],
    });
    expect(obs.url).toBeNull();
    expect(obs.missing).toContain("url");
  });

  it("tutar ve barkod yardimcilari", () => {
    expect(amountToKurus(6399.2)).toBe(639_920);
    expect(amountToKurus("124999.00")).toBe(12_499_900);
    expect(amountToKurus(Number.NaN)).toBeNull();
    expect(gtin14("TYB1234567")).toBeNull();
    expect(gtin14("4066765863348")).toBe("04066765863348");
    expect(gtin14("4066765863349")).toBeNull();
  });
});

describe("sayfa girdileri", () => {
  it("kayitli HTML ve DOM benzeri belge ayni girdiyi verir", () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product"}</script><script>window["a"]=1</script><script id="reduxStore" type="text/javascript">{"x":1}</script>';
    const fromHtml = pageInputsFromHtml(html, "https://www.trendyol.com/a/b-p-1", "t");
    expect(fromHtml.jsonLdTexts).toEqual(['{"@type":"Product"}']);
    expect(fromHtml.scriptTexts).toEqual(['window["a"]=1', '{"x":1}']);
    expect(fromHtml.reduxStoreText).toBe('{"x":1}');
    const doc = {
      querySelectorAll: () => [
        { type: "application/ld+json", textContent: '{"@type":"Product"}' },
        { type: "", textContent: 'window["a"]=1' },
      ],
    };
    const fromDom = collectPageInputs(doc, "https://www.trendyol.com/a/b-p-1", "t");
    expect(fromDom.jsonLdTexts).toEqual(fromHtml.jsonLdTexts);
    expect(fromDom.scriptTexts[0]).toBe('window["a"]=1');
  });
});

describe("yenileme kotasi: haftada en fazla 1, ayda en fazla 4", () => {
  const sha = "a".repeat(64);
  const at = (iso: string) => new Date(iso);

  it("7 gun dolmadan ikinci dongu yok; takvim haftasi siniri da delinmez", () => {
    let { ledger, cycle } = startCycle(emptyLedger(), at("2026-10-18T20:00:00Z"), {
      sha256: sha,
      total: 2,
    });
    cycle = recordItem(cycle, 0, "observed", at("2026-10-18T20:01:00Z"));
    cycle = recordItem(cycle, 1, "missing", at("2026-10-18T20:02:00Z"));
    ledger = replaceCycle(ledger, cycle);
    expect(cycle.status).toBe("complete");
    // Pazar aksami -> Pazartesi sabahi: takvim haftasi degisti ama 7 gun gecmedi.
    const d = canStartCycle(ledger, at("2026-10-19T06:00:00Z"));
    expect(d).toEqual({
      ok: false,
      reason: "weekly_limit",
      nextAllowedAt: "2026-10-25T20:00:00.000Z",
    });
    expect(canStartCycle(ledger, at("2026-10-25T20:00:00Z"))).toEqual({ ok: true });
  });

  it("takvim ayinda 5. dongu reddedilir (1, 8, 15, 22, 29 Ekim)", () => {
    let ledger = emptyLedger();
    for (const day of ["01", "08", "15", "22"]) {
      ledger = startCycle(ledger, at(`2026-10-${day}T09:00:00Z`), { sha256: sha, total: 0 }).ledger;
    }
    expect(canStartCycle(ledger, at("2026-10-29T09:00:00Z"))).toEqual({
      ok: false,
      reason: "monthly_limit",
      nextAllowedAt: "2026-10-31T21:00:00.000Z",
    });
    expect(canStartCycle(ledger, at("2026-11-01T09:00:00Z"))).toEqual({ ok: true });
  });

  it("ay sinirlari Istanbul saatine gore", () => {
    expect(istanbulMonthKey(at("2026-10-31T20:59:59Z"))).toBe("2026-10");
    expect(istanbulMonthKey(at("2026-10-31T21:00:00Z"))).toBe("2026-11");
  });

  it("kesilen dongu yalnizca kendi penceresinde ve ayni hedef listesiyle devam eder", () => {
    const { ledger, cycle } = startCycle(emptyLedger(), at("2026-10-15T00:00:00Z"), {
      sha256: sha,
      total: 10,
    });
    const l2 = replaceCycle(ledger, recordItem(cycle, 0, "observed", at("2026-10-15T00:01:00Z")));
    const r = resumeCycle(l2, at("2026-10-16T00:00:00Z"), sha);
    expect(r.ok && r.cycle.cursor).toBe(1);
    expect(resumeCycle(l2, at("2026-10-16T00:00:00Z"), "b".repeat(64))).toEqual({
      ok: false,
      reason: "targets_changed",
    });
    expect(resumeCycle(l2, at("2026-10-22T00:00:01Z"), sha)).toEqual({
      ok: false,
      reason: "window_elapsed",
    });
    const expired = expireStale(l2, at("2026-10-22T00:00:01Z"));
    expect(expired.cycles[0]?.status).toBe("expired");
    // Ayni urun iki kez islenemez.
    expect(() => recordItem(cycle, 5, "observed", at("2026-10-15T00:02:00Z"))).toThrow(
      "cursor_mismatch",
    );
  });

  it("acik dongu varken yeni dongu baslatilamaz", () => {
    const { ledger } = startCycle(emptyLedger(), at("2026-10-15T00:00:00Z"), {
      sha256: sha,
      total: 10,
    });
    expect(() =>
      startCycle(ledger, at("2026-10-23T00:00:00Z"), { sha256: sha, total: 1 }),
    ).not.toThrow();
    expect(canStartCycle(ledger, at("2026-10-16T00:00:00Z")).ok).toBe(false);
  });
});

describe("sitemap eslemesi ve katalog satirlari", () => {
  const gen = {
    lastmod: "2026-10-12T08:51:44Z",
    ids: Uint32Array.from([5999429, 813659620, 857296094]),
  };

  it("ikili arama", () => {
    expect(hasId(gen.ids, 813659620)).toBe(true);
    expect(hasId(gen.ids, 857296083)).toBe(false);
    expect(matchToSitemap("857296094", gen)).toEqual({
      status: "in_sitemap",
      lastmod: gen.lastmod,
    });
    expect(matchToSitemap(null, gen)).toEqual({ status: "no_content_id" });
  });

  it("satici basina offer, varyant, INSERT adayi, kaynak ve zaman", () => {
    const obs = extractTrendyolProductPage(asInput(samba));
    const rows = catalogRowsFromObservation(obs, matchToSitemap(obs.contentId, gen));
    expect(rows.seller).toEqual({ external_id: "106871", name: "SuperStep" });
    expect(rows.offer?.external_id).toBe("813659620:106871");
    expect(rows.offer?.url).toBe(
      "https://www.trendyol.com/adidas/samba-og-bej-spor-ayakkabi-id0478-p-813659620?merchantId=106871",
    );
    expect(rows.offer?.current_price).toBe(399_950);
    expect(rows.offer?.list_price).toBe(559_930);
    // Ornekteki 2 beden saticinin listesinde (gozlenen tek varyant: 38) yok: baglanmaz.
    expect(rows.variants).toEqual([]);
    expect(rows.unattributedVariants).toBe(2);
    expect(rows.pricePoint).toEqual({
      observed_at: "2026-10-14T22:30:23Z",
      price: 399_950,
      list_price: 559_930,
      in_stock: true,
    });
    expect(rows.provider).toBe("trendyol_browser_page");
    expect(rows.schemaGaps.length).toBeGreaterThan(0);
  });

  it("fiyat yoksa price_point uretilmez", () => {
    const obs = extractTrendyolProductPage({
      url: "https://www.trendyol.com/x/y-p-5999429",
      observedAt: "t",
      scriptTexts: [
        'window["__envoy__SHARED_PROPS"]={"product":{"id":5999429,"name":"Y","brand":{"name":"X"},"merchantListing":{"merchant":{"id":1,"name":"S"}}}}',
      ],
      jsonLdTexts: [],
    });
    const rows = catalogRowsFromObservation(obs, matchToSitemap(obs.contentId, gen));
    expect(rows.offer?.current_price).toBeNull();
    expect(rows.pricePoint).toBeNull();
    expect(rows.offer?.in_stock).toBe(false);
    expect(rows.skipped).toEqual(["no_verified_price", "no_stock_signal"]);
  });
});

describe("arama sayfasi (eklentiden tasinan)", () => {
  it("Trendyol gomulu liste: sorguyla eslesen urunler, stok bilinmiyor", () => {
    const props = {
      data: {
        products: [
          {
            name: "iPhone 16 Pro 128 GB Çöl Titanyum",
            brand: "Apple",
            url: "/apple/iphone-16-pro-128gb-col-titanyum-p-857296094?merchantId=724838",
            image: "https://cdn.dsmcdn.com/a.jpg",
            price: { discountedPriceText: "124.999", currency: "TL" },
            groupId: 653969108,
            variantValue: "Tek Ebat",
          },
          {
            name: "iPhone 16 Pro Kılıf",
            brand: "X",
            url: "/x/kilif-p-1",
            image: "https://cdn.dsmcdn.com/b.jpg",
            price: { discountedPriceText: "99", currency: "TL" },
          },
        ],
      },
    };
    const r = extractSearchPage({
      url: "https://www.trendyol.com/sr?q=iphone",
      observedAt: "t",
      scriptTexts: [`window["__single-search-result__PROPS"]=${JSON.stringify(props)}`],
      jsonLdTexts: [],
      query: "iPhone 16 Pro 128 GB",
    });
    expect(r.source).toBe("trendyol-search-props");
    expect(r.totalOnPage).toBe(2);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]).toMatchObject({
      contentId: "857296094",
      sellerId: "724838",
      priceKurus: 12_499_900,
      availability: "unknown",
    });
    expect(r.products[0]?.missing).toEqual(["stock"]);
  });

  it("Hepsiburada reduxStore ItemList", () => {
    const items = [
      {
        item: {
          name: "Apple iPhone 16 Pro 128 GB",
          url: "https://www.hepsiburada.com/apple-iphone-16-pro-p-HBC1",
          image: "https://productimages.hepsiburada.net/a.jpg",
          offers: {
            price: "119999.00",
            priceCurrency: "TRY",
            availability: "https://schema.org/InStock",
          },
        },
      },
    ];
    const redux = JSON.stringify({
      voltranState: {
        fragmentsMap: {
          a: { ProductList: { seoState: { itemListElement: JSON.stringify(items) } } },
        },
      },
    });
    const r = extractSearchPage({
      url: "https://www.hepsiburada.com/ara?q=iphone",
      observedAt: "t",
      scriptTexts: [],
      jsonLdTexts: [],
      reduxStoreText: redux,
      query: "iPhone 16 Pro 128 GB",
    });
    expect(r.source).toBe("hepsiburada-redux-itemlist");
    expect(r.products[0]).toMatchObject({
      store: "Hepsiburada",
      priceKurus: 11_999_900,
      availability: "in_stock",
    });
  });
});
