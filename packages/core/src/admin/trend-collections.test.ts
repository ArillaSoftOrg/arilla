/**
 * Trend koleksiyonu yönetimi (karar 0149) — birim. Yetki reddi ve doğrulama veritabanından
 * önce; ayrıntı/slug/liste doğrulaması ve kart uyarıları saf fonksiyonlardır.
 */
import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  BLOCKING_WARNINGS,
  changedTrendDetails,
  createTrend,
  getTrendEditor,
  PRICE_SPREAD_FACTOR,
  parseProductIdList,
  parseTrendDetails,
  parseTrendSlug,
  searchTrendProducts,
  setTrendCuration,
  setTrendProducts,
  suggestTrendSlug,
  TREND_MANUAL_MAX_PRODUCTS,
  type TrendProductCard,
  trendProductWarnings,
  updateTrendDetails,
} from "./trend-collections.ts";
import { TrendValidationError } from "./trends-admin.ts";

const untouchable = new Proxy({} as Database, {
  get() {
    throw new Error("veritabanına dokunuldu");
  },
});

const admin: AdminActor = { userId: 1, role: "admin" };
const DENIED: AdminActor[] = [
  { userId: 2, role: "moderator" },
  { userId: 3, role: "creator" },
  { userId: 4, role: "user" },
];

const details = {
  title: "Sonbahar ve Kış İçin Parfüm Seçme Rehberi",
  description: "Serin havalar için seçki.",
  category: "guzellik",
  trendType: "seasonal",
  heroImageUrl: null,
  activeFrom: null,
  activeUntil: null,
};

describe("yetki reddi veritabanından önce (karar 0149)", () => {
  const calls: [string, (actor: AdminActor) => unknown][] = [
    [
      "createTrend",
      (a) =>
        createTrend(untouchable, a, {
          slug: "yeni-koleksiyon",
          details,
          curation: "manual",
          reason: "geçerli gerekçe",
        }),
    ],
    [
      "updateTrendDetails",
      (a) =>
        updateTrendDetails(untouchable, a, {
          trendId: 1,
          expected: details,
          next: details,
          reason: "geçerli gerekçe",
        }),
    ],
    [
      "setTrendCuration",
      (a) =>
        setTrendCuration(untouchable, a, {
          trendId: 1,
          next: "manual",
          expected: "auto",
          reason: "geçerli gerekçe",
        }),
    ],
    [
      "setTrendProducts",
      (a) =>
        setTrendProducts(untouchable, a, {
          trendId: 1,
          productIds: [1, 2, 3, 4],
          expectedProductIds: [],
          reason: "geçerli gerekçe",
        }),
    ],
    ["getTrendEditor", (a) => getTrendEditor(untouchable, a, 1)],
    ["searchTrendProducts", (a) => searchTrendProducts(untouchable, a, { query: "parfüm" })],
  ];
  for (const [name, call] of calls) {
    for (const actor of DENIED) {
      it(`${name}: ${actor.role} reddedilir`, async () => {
        await expect(async () => call(actor)).rejects.toThrow(AdminForbiddenError);
      });
    }
  }
});

describe("doğrulama veritabanından önce", () => {
  const invalid: [string, () => unknown][] = [
    [
      "kısa gerekçe",
      () =>
        createTrend(untouchable, admin, {
          slug: "ok",
          details,
          curation: "manual",
          reason: "abc",
        }),
    ],
    [
      "geçersiz slug",
      () =>
        createTrend(untouchable, admin, {
          slug: "Büyük Harf",
          details,
          curation: "manual",
          reason: "gerekçe yeterli",
        }),
    ],
    [
      "geçersiz tür",
      () =>
        createTrend(untouchable, admin, {
          slug: "ok",
          details,
          curation: "editor",
          reason: "gerekçe yeterli",
        }),
    ],
    [
      "tekrarlı ürün",
      () =>
        setTrendProducts(untouchable, admin, {
          trendId: 1,
          productIds: [1, 1],
          expectedProductIds: [],
          reason: "gerekçe yeterli",
        }),
    ],
    [
      "metin ürün kimliği",
      () =>
        setTrendProducts(untouchable, admin, {
          trendId: 1,
          productIds: ["1; DROP TABLE trend"],
          expectedProductIds: [],
          reason: "gerekçe yeterli",
        }),
    ],
    [
      "geçersiz trend kimliği",
      () =>
        setTrendCuration(untouchable, admin, {
          trendId: 0,
          next: "manual",
          expected: "auto",
          reason: "gerekçe yeterli",
        }),
    ],
    ["kısa arama", () => searchTrendProducts(untouchable, admin, { query: "a" })],
  ];
  for (const [name, call] of invalid) {
    it(name, async () => {
      await expect(async () => call()).rejects.toThrow(TrendValidationError);
    });
  }
});

describe("ayrıntı doğrulaması", () => {
  it("boşlukları sadeleştirir, tarihleri ayrıştırır", () => {
    const parsed = parseTrendDetails({
      ...details,
      title: "  Sonbahar   ve kış  ",
      activeFrom: "2026-10-01T00:00:00Z",
      activeUntil: "2027-03-01T00:00:00Z",
    });
    expect(parsed.title).toBe("Sonbahar ve kış");
    expect(parsed.activeFrom?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it.each([
    ["boş başlık", { title: "  " }],
    ["uzun başlık", { title: "a".repeat(121) }],
    ["uzun açıklama", { description: "a".repeat(281) }],
    ["kategori", { category: "spor" }],
    ["tür", { trendType: "daily" }],
    ["http görsel", { heroImageUrl: "http://example.test/a.jpg" }],
    ["kimlikli görsel", { heroImageUrl: "https://u:p@example.test/a.jpg" }],
    ["javascript görsel", { heroImageUrl: "javascript:alert(1)" }],
    ["ters pencere", { activeFrom: "2027-01-01", activeUntil: "2026-01-01" }],
    ["bozuk tarih", { activeFrom: "dün" }],
  ])("%s reddedilir", (_name, patch) => {
    expect(() => parseTrendDetails({ ...details, ...patch })).toThrow(TrendValidationError);
  });

  it("boş görsel adresi null olur", () => {
    expect(parseTrendDetails({ ...details, heroImageUrl: "  " }).heroImageUrl).toBeNull();
  });

  it("değişen alanlar tarihleri değerle karşılaştırır", () => {
    const a = parseTrendDetails({ ...details, activeFrom: "2026-10-01T00:00:00Z" });
    const b = parseTrendDetails({ ...details, activeFrom: new Date("2026-10-01T00:00:00Z") });
    expect(changedTrendDetails(a, b)).toEqual([]);
    expect(changedTrendDetails(a, { ...b, title: "Başka" })).toEqual(["title"]);
  });
});

describe("slug", () => {
  it("geçerli adres", () => {
    expect(parseTrendSlug("sonbahar-ve-kis")).toBe("sonbahar-ve-kis");
  });
  it.each(["", "Sonbahar", "a--b", "-a", "a-", "a_b", "a".repeat(81)])("%s reddedilir", (slug) => {
    expect(() => parseTrendSlug(slug)).toThrow(TrendValidationError);
  });
  it("Türkçe başlıktan öneri", () => {
    expect(suggestTrendSlug("Sonbahar ve Kış İçin Parfüm Seçme Rehberi")).toBe(
      "sonbahar-ve-kis-icin-parfum-secme-rehberi",
    );
    expect(suggestTrendSlug("  Ağustos'un  ÇOK özel  seçkisi! ")).toBe(
      "agustos-un-cok-ozel-seckisi",
    );
    expect(() => parseTrendSlug(suggestTrendSlug("İĞNE IŞIK Üzüm"))).not.toThrow();
  });
});

describe("ürün listesi", () => {
  it("sırayı korur", () => {
    expect(parseProductIdList([3, 1, 2])).toEqual([3, 1, 2]);
  });
  it("üst sınır", () => {
    const ids = Array.from({ length: TREND_MANUAL_MAX_PRODUCTS + 1 }, (_, i) => i + 1);
    expect(() => parseProductIdList(ids)).toThrow(TrendValidationError);
    expect(parseProductIdList(ids.slice(1))).toHaveLength(TREND_MANUAL_MAX_PRODUCTS);
  });
  it.each([[[0]], [[-1]], [[1.5]], [[Number.MAX_SAFE_INTEGER + 1]], ["1,2"], [null]])(
    "%j reddedilir",
    (raw) => {
      expect(() => parseProductIdList(raw)).toThrow(TrendValidationError);
    },
  );
});

describe("kart uyarıları", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const healthy: Omit<TrendProductCard, "showable" | "warnings"> = {
    id: 1,
    slug: "urun",
    title: "Ürün",
    brandName: "Marka",
    imageUrl: "https://example.test/a.jpg",
    minPrice: 100_000,
    maxPrice: 120_000,
    offerCount: 2,
    inStockCount: 1,
    foreignOfferCount: 0,
    publicationState: "published",
    priceUpdatedAt: new Date("2026-10-23T00:00:00Z"),
    sourceMerchant: null,
    activeTryOffers: 2,
    freshTryOffers: 2,
    affiliateOffers: 1,
    maxPriceObservations: 5,
  };

  it("sağlıklı üründe uyarı yok", () => {
    expect(trendProductWarnings(healthy, now)).toEqual([]);
  });

  it("gösterilemez nedenler engelleyicidir", () => {
    const warnings = trendProductWarnings(
      {
        ...healthy,
        publicationState: "held",
        imageUrl: null,
        minPrice: null,
        maxPrice: null,
        inStockCount: 0,
      },
      now,
    );
    expect(warnings).toEqual(
      expect.arrayContaining(["not_published", "missing_image", "no_try_price", "out_of_stock"]),
    );
    expect(warnings.every((w) => BLOCKING_WARNINGS.has(w))).toBe(true);
  });

  it("bayat fiyat, bayat teklif, ince geçmiş, affiliate yok: bilgi uyarısı", () => {
    const warnings = trendProductWarnings(
      {
        ...healthy,
        priceUpdatedAt: new Date("2026-10-16T00:00:00Z"),
        freshTryOffers: 0,
        maxPriceObservations: 1,
        affiliateOffers: 0,
      },
      now,
    );
    expect(warnings).toEqual(["stale_price", "stale_offer", "thin_price_history", "no_affiliate"]);
    expect(warnings.some((w) => BLOCKING_WARNINGS.has(w))).toBe(false);
  });

  it("fiyat tarihi yoksa bayat sayılır", () => {
    expect(trendProductWarnings({ ...healthy, priceUpdatedAt: null }, now)).toContain(
      "stale_price",
    );
  });

  it("mağazalar arası aşırı fiyat farkı şüphelidir", () => {
    const max = (healthy.minPrice ?? 0) * PRICE_SPREAD_FACTOR;
    expect(trendProductWarnings({ ...healthy, maxPrice: max }, now)).not.toContain("price_spread");
    expect(trendProductWarnings({ ...healthy, maxPrice: max + 1 }, now)).toContain("price_spread");
  });
});
