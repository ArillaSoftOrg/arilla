import { describe, expect, it } from "vitest";
import { extractTrendyolPage, isTrendyolListingPath } from "./extract-trendyol.ts";
import iphone from "./fixtures/iphone-857296094.json";
import listing from "./fixtures/listing-cat1.json";
import samba from "./fixtures/samba-813659620.json";
import {
  type CapturedPage,
  captureTrendyolPage,
  flushPendingListings,
  parseToExtensionMessage,
  parseToPageMessage,
  planRelayBatch,
  RELAY_CHANNEL,
  type RelayState,
} from "./trendyol-relay.ts";

const cap = (
  fx: { url: string; observedAt: string; scriptTexts: string[]; jsonLdTexts: string[] },
  id: string,
): CapturedPage => ({
  captureId: id,
  url: fx.url,
  capturedAt: fx.observedAt,
  page: extractTrendyolPage(fx),
});

const fresh = (maxRequests = 500): RelayState => ({
  runId: 7,
  requestsMade: 0,
  maxRequests,
  processedCaptures: new Set(),
  sentProducts: new Set(),
});

describe("parti planlama", () => {
  it("bir acilan sayfa = bir istek; kayitlar sunucu sozlesmesindeki alanlarla", () => {
    const state = fresh();
    const plan = planRelayBatch(state, [cap(iphone, "capture-0001"), cap(listing, "capture-0002")]);
    expect(plan.stop).toBeNull();
    expect(plan.batch?.requestsMade).toBe(2);
    expect(plan.batch?.units.map((u) => [u.kind, u.query, u.status, u.itemsFound])).toEqual([
      ["product_page", "857296094", "done", 1],
      ["listing_page", "/apple-cep-telefonu-x-b101470-c103498", "done", 2],
    ]);
    // Urun sayfasi kaydi hemen; liste kartlari kosu kapanana / urun sayfasi gelene dek bekler.
    expect(plan.batch?.records).toHaveLength(1);
    expect(state.pendingListings?.size).toBe(2);
    expect(plan.batch?.records[0]).toMatchObject({
      externalId: "857296094",
      priceMinor: 12_499_900,
      sellerName: "Akarsu İletişim Teknoloji Ürünleri",
      sourcePage: "product_page",
    });
    expect(plan.captureIds).toEqual(["capture-0001", "capture-0002"]);
  });

  it("ayni yakalama tekrar islenmez; ayni urun kosuda bir kez gonderilir", () => {
    const state = fresh();
    planRelayBatch(state, [cap(samba, "capture-0001")]);
    const again = planRelayBatch(state, [
      cap(samba, "capture-0001"),
      { ...cap(samba, "capture-0003") },
    ]);
    expect(again.skipped.duplicateCaptures).toBe(1);
    expect(again.skipped.duplicateProducts).toBe(1);
    expect(again.batch?.records).toEqual([]);
    expect(again.batch?.units[0]?.itemsNew).toBe(0);
    expect(state.requestsMade).toBe(2);
  });

  it("istek butcesi asilmaz: dolunca durur, fazlasi gonderilmez", () => {
    const state = fresh(1);
    const plan = planRelayBatch(state, [cap(iphone, "capture-0001"), cap(samba, "capture-0002")]);
    expect(plan.stop).toBe("budget");
    expect(plan.batch?.units).toHaveLength(1);
    expect(plan.captureIds).toEqual(["capture-0001"]);
  });

  it("engel/yapisiz urun sayfasi kosuyu durdurur", () => {
    const blocked: CapturedPage = {
      captureId: "capture-0009",
      url: "https://www.trendyol.com/x/y-p-1",
      capturedAt: "2026-10-15T00:00:00Z",
      page: extractTrendyolPage({
        url: "https://www.trendyol.com/x/y-p-1",
        observedAt: "2026-10-15T00:00:00Z",
        scriptTexts: ["challenge"],
        jsonLdTexts: [],
      }),
    };
    const plan = planRelayBatch(fresh(), [blocked, cap(iphone, "capture-0010")]);
    expect(plan.stop).toBe("blocked");
    expect(plan.batch?.units).toEqual([
      expect.objectContaining({
        kind: "product_page",
        status: "blocked",
        errorCode: "structure_missing",
      }),
    ]);
    expect(plan.batch?.records).toEqual([]);
  });

  it("urun/liste olmayan sayfa butceden dusmez ve kosuyu durdurmaz", () => {
    const home: CapturedPage = {
      captureId: "capture-0011",
      url: "https://www.trendyol.com/",
      capturedAt: "2026-10-15T00:00:00Z",
      page: extractTrendyolPage({
        url: "https://www.trendyol.com/",
        observedAt: "2026-10-15T00:00:00Z",
        scriptTexts: [],
        jsonLdTexts: [],
      }),
    };
    const state = fresh();
    const plan = planRelayBatch(state, [home]);
    expect(plan.stop).toBeNull();
    expect(plan.batch).toBeNull();
    expect(state.requestsMade).toBe(0);
    expect(plan.captureIds).toEqual(["capture-0011"]);
  });
});

describe("liste adresi tanima", () => {
  it("filtre, arama terimi ve /sr", () => {
    expect(
      isTrendyolListingPath("https://www.trendyol.com/apple-cep-telefonu-x-b101470-c103498"),
    ).toBe("/apple-cep-telefonu-x-b101470-c103498");
    expect(isTrendyolListingPath("https://www.trendyol.com/adidas-samba-y-s10410")).toBe(
      "/adidas-samba-y-s10410",
    );
    expect(isTrendyolListingPath("https://www.trendyol.com/sr?q=x")).toBe("/sr");
    expect(isTrendyolListingPath("https://www.trendyol.com/")).toBeNull();
    expect(isTrendyolListingPath("https://evil.example/a-x-b")).toBeNull();
  });
});

describe("mesaj protokolu", () => {
  it("yalniz kanal + beklenen bicim kabul edilir", () => {
    expect(parseToPageMessage({ type: "pages", pages: [] })).toBeNull();
    expect(parseToPageMessage({ channel: RELAY_CHANNEL, type: "hello", version: "0.1.0" })).toEqual(
      {
        channel: RELAY_CHANNEL,
        type: "hello",
        version: "0.1.0",
      },
    );
    const msg = parseToPageMessage({
      channel: RELAY_CHANNEL,
      type: "pages",
      pages: [cap(iphone, "capture-0001"), { captureId: "kotu", url: 1 }],
    });
    expect(msg?.type === "pages" && msg.pages.length).toBe(1);
    expect(parseToExtensionMessage({ channel: RELAY_CHANNEL, type: "arm", runId: -1 })).toBeNull();
    expect(parseToExtensionMessage({ channel: RELAY_CHANNEL, type: "arm", runId: 3 })).toEqual({
      channel: RELAY_CHANNEL,
      type: "arm",
      runId: 3,
    });
  });

  it("icerik betigi yakalamasi DOM'dan okur", () => {
    const doc = {
      querySelectorAll: () => [
        { type: "application/ld+json", textContent: iphone.jsonLdTexts[0] as string },
        { type: "", textContent: iphone.scriptTexts[0] as string },
      ],
    };
    const c = captureTrendyolPage(
      doc,
      iphone.url,
      new Date("2026-10-15T00:00:00Z"),
      "capture-0100",
    );
    expect(c.page.items[0]?.externalId).toBe("857296094");
    expect(c.page.items[0]?.sourceObservedAt).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("eklenti kuyrugu", () => {
  it("ayni adres tekrar yakalanirsa son hali kalir; tavan asilinca eskiler atilir", async () => {
    const { enqueueCapture, ackCaptures, MAX_QUEUED_CAPTURES } = await import(
      "./trendyol-relay.ts"
    );
    let q = enqueueCapture([], cap(iphone, "capture-a001")).queue;
    q = enqueueCapture(q, cap(iphone, "capture-a002")).queue;
    expect(q.map((c) => c.captureId)).toEqual(["capture-a002"]);
    for (let i = 0; i < MAX_QUEUED_CAPTURES + 5; i++) {
      const r = enqueueCapture(q, {
        ...cap(samba, `capture-b${i}xxxx`),
        url: `https://www.trendyol.com/a/b-p-${i}`,
      });
      q = r.queue;
    }
    expect(q.length).toBe(MAX_QUEUED_CAPTURES);
    expect(ackCaptures(q, [q[0]?.captureId as string]).length).toBe(MAX_QUEUED_CAPTURES - 1);
  });

  it("yalniz urun ve liste sayfalari toplanir", async () => {
    const { isCollectibleTrendyolUrl } = await import("./trendyol-relay.ts");
    expect(isCollectibleTrendyolUrl("https://www.trendyol.com/apple/x-p-1?merchantId=2")).toBe(
      true,
    );
    expect(isCollectibleTrendyolUrl("https://www.trendyol.com/adidas-samba-y-s10410")).toBe(true);
    expect(isCollectibleTrendyolUrl("https://www.trendyol.com/hesabim/siparislerim")).toBe(false);
    expect(isCollectibleTrendyolUrl("https://www.trendyol.com/")).toBe(false);
  });
});

describe("sitemap kapsami", () => {
  it("katalog kimlikleri sitemap uretimiyle karsilastirilir; erisim varsayilmaz", async () => {
    const { sitemapCoverage } = await import("./trendyol-coverage.ts");
    const sitemap = Uint32Array.from([5999429, 813659620, 857296083, 857296094]);
    expect(sitemapCoverage(sitemap, ["813659620", "857296094", "1212864992", "kotu"])).toEqual({
      sitemapIds: 4,
      catalogIds: 3,
      inBoth: 2,
      catalogOnly: 1,
      coveragePct: 50,
    });
  });
});

describe("ayni kosuda liste karti ve urun sayfasi", () => {
  it("urun sayfasi gelirse liste kaydi dusulur; kalanlar kapanista bir kez gonderilir", () => {
    const state = fresh();
    planRelayBatch(state, [cap(listing, "capture-l001")]);
    expect(state.pendingListings?.size).toBe(2);
    // Liste kartindaki urunun (1198082362) urun sayfasi: ana satici adi ve kazanan beden ile.
    const product = cap(
      {
        url: "https://www.trendyol.com/apple/iphone-18-pro-max-512gb-burgundy-p-1198082362",
        observedAt: "2026-10-12T00:50:00Z",
        scriptTexts: [
          'window["__envoy__SHARED_PROPS"]={"product":{"id":1198082362,"name":"iPhone 18 Pro Max 512GB Burgundy","brand":{"name":"Apple"},"merchantListing":{"merchant":{"id":968,"name":"Trendyol"},"winnerVariant":{"itemNumber":5,"price":{"currency":"TRY","sellingPrice":{"value":193899},"discountedPrice":{"value":193859},"originalPrice":{"value":197809}}},"variants":[{"itemNumber":5,"value":""}]}}}',
        ],
        jsonLdTexts: [],
      },
      "capture-p001",
    );
    const plan = planRelayBatch(state, [product]);
    expect(plan.batch?.records).toEqual([
      expect.objectContaining({
        externalId: "1198082362",
        sourcePage: "product_page",
        sellerName: "Trendyol",
        priceMinor: 19_389_900,
        basketPriceMinor: 19_385_900,
      }),
    ]);
    const flushed = flushPendingListings(state);
    expect(flushed?.units).toEqual([]);
    expect(flushed?.records.map((r) => r.externalId)).toEqual(["762254881"]);
    expect(flushed?.requestsMade).toBe(2); // istek sayilmaz
    expect(flushPendingListings(state)).toBeNull();
    // Ayni liste tekrar acilsa da gonderilmis urunler yeniden gonderilmez.
    const again = planRelayBatch(state, [cap(listing, "capture-l002")]);
    expect(again.batch?.records).toEqual([]);
    expect(state.pendingListings?.size).toBe(0);
  });
});

describe("eklenti gizliligi", () => {
  it("yakalanan adres sorgu ve parca tasimaz (arama terimi, takip parametresi)", async () => {
    const { sanitizeCapturedUrl } = await import("./trendyol-relay.ts");
    expect(sanitizeCapturedUrl("https://www.trendyol.com/sr?q=kisisel+arama&pi=2")).toBe(
      "https://www.trendyol.com/sr",
    );
    expect(sanitizeCapturedUrl("https://www.trendyol.com/a/b-p-1?merchantId=2&sid=x#y")).toBe(
      "https://www.trendyol.com/a/b-p-1",
    );
    const doc = { querySelectorAll: () => [] };
    const c = captureTrendyolPage(
      doc,
      "https://www.trendyol.com/sr?q=gizli",
      new Date(0),
      "capture-0200",
    );
    expect(JSON.stringify(c)).not.toContain("gizli");
  });
});
