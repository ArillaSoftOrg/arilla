import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  brandFilterParam,
  PRODUCT_FILTER_KEYS,
  parseBrandFilter,
  parseProductListParams,
  UNASSIGNED,
} from "./catalog-filters.ts";
import { classificationRunStatus, STALL_AFTER_MS } from "./catalog-panel.ts";

describe("ürün listesi adres filtreleri", () => {
  it("boş adres: süzgeç yok, panel yok, imleç yok", () => {
    const { filter, state, panelId } = parseProductListParams({});
    expect(panelId).toBeUndefined();
    expect(filter.before).toBeUndefined();
    expect(filter.after).toBeUndefined();
    expect(Object.values(state).filter(Boolean)).toEqual([]);
    expect(activeFilterCount(state)).toBe(0);
  });

  it("geçerli değerleri birlikte kabul eder (AND)", () => {
    const { filter, state } = parseProductListParams({
      q: "  kulaklık  ",
      durum: "draft",
      magaza: "demo-aliexpress",
      marka: "42",
      kategori: "elektronik/ses",
      siniflandirma: "review",
      guven: "medium",
      fiyat: "foreign_only",
      gorsel: "without",
      guncellik: "7d",
      kalite: "no_brand",
      sorun: "duplicate_gtin",
    });
    expect(filter).toMatchObject({
      query: "kulaklık",
      state: "draft",
      merchant: "demo-aliexpress",
      brand: 42,
      category: "elektronik/ses",
      classification: "review",
      confidence: "medium",
      price: "foreign_only",
      image: "without",
      freshness: "7d",
      quality: "no_brand",
      issue: "duplicate_gtin",
    });
    expect(activeFilterCount(state)).toBe(12);
  });

  it("tanınmayan ya da tehlikeli değerleri düşürür", () => {
    const { filter, state } = parseProductListParams({
      durum: "deleted",
      magaza: "Robert'); DROP TABLE product;--",
      kategori: "elektronik/%",
      siniflandirma: "maybe",
      guven: "100",
      fiyat: "usd",
      gorsel: "1",
      guncellik: "90d",
      kalite: "nope",
      sorun: "x",
    });
    expect(filter.state).toBeUndefined();
    expect(filter.merchant).toBeUndefined();
    expect(filter.category).toBeUndefined();
    expect(filter.classification).toBeUndefined();
    expect(filter.confidence).toBeUndefined();
    expect(filter.price).toBeUndefined();
    expect(filter.image).toBeUndefined();
    expect(filter.freshness).toBeUndefined();
    expect(filter.quality).toBeUndefined();
    expect(filter.issue).toBeUndefined();
    expect(activeFilterCount(state)).toBe(0);
  });

  it("varsayılan yayın durumu etkin filtre sayılmaz", () => {
    expect(activeFilterCount(parseProductListParams({ durum: "published" }).state)).toBe(0);
    expect(activeFilterCount(parseProductListParams({ durum: "all" }).state)).toBe(1);
  });

  it("kategori ve marka için 'atanmamış'", () => {
    const { filter } = parseProductListParams({ kategori: UNASSIGNED, marka: UNASSIGNED });
    expect(filter.category).toBe(UNASSIGNED);
    expect(filter.brand).toBe(UNASSIGNED);
  });

  it("imleç: `once` kazanır; ikisi yoksa eski `sayfa`", () => {
    expect(parseProductListParams({ once: "100", sonra: "50" }).filter).toMatchObject({
      before: 100,
      after: undefined,
      page: undefined,
    });
    expect(parseProductListParams({ sonra: "50", sayfa: "3" }).filter).toMatchObject({
      after: 50,
      page: undefined,
    });
    expect(parseProductListParams({ sayfa: "3" }).filter.page).toBe(3);
    expect(parseProductListParams({ once: "-1" }).filter.before).toBeUndefined();
    expect(parseProductListParams({ once: "1e9" }).filter.before).toBeUndefined();
  });

  it("panel kimliği yalnızca pozitif tamsayı", () => {
    expect(parseProductListParams({ urun: "12" }).panelId).toBe(12);
    expect(parseProductListParams({ urun: "0" }).panelId).toBeUndefined();
    expect(parseProductListParams({ urun: "abc" }).panelId).toBeUndefined();
  });

  it("filtre durumu yalnızca bilinen anahtarları taşır (sayfalama/panel yok)", () => {
    const { state } = parseProductListParams({ q: "a b", once: "9", urun: "3" });
    expect(
      Object.keys(state).every((key) => (PRODUCT_FILTER_KEYS as readonly string[]).includes(key)),
    ).toBe(true);
  });
});

describe("marka süzgeci", () => {
  it("kimlik, atanmamış ya da ad", () => {
    expect(parseBrandFilter("7")).toBe(7);
    expect(parseBrandFilter("none")).toBe(UNASSIGNED);
    expect(parseBrandFilter("  Xiaomi ")).toEqual({ name: "Xiaomi" });
    expect(parseBrandFilter("")).toBeUndefined();
    expect(parseBrandFilter(undefined)).toBeUndefined();
    expect(parseBrandFilter("x".repeat(200))).toEqual({ name: "x".repeat(80) });
  });

  it("adrese geri yazılır", () => {
    for (const raw of ["7", "none", "Xiaomi"]) {
      expect(brandFilterParam(parseBrandFilter(raw))).toBe(raw);
    }
    expect(brandFilterParam(undefined)).toBeUndefined();
  });
});

describe("sınıflandırma işlem durumu", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const checkpoint = (updatedMsAgo: number, completed = false) => ({
    updatedAt: ago(updatedMsAgo),
    completedAt: completed ? ago(updatedMsAgo) : null,
  });

  it("hiç çalışmadı", () => {
    expect(classificationRunStatus(null, null, now)).toBe("never");
  });

  it("koşu açık ve kontrol noktası yeni → çalışıyor", () => {
    expect(
      classificationRunStatus(
        checkpoint(60_000),
        { status: "running", startedAt: ago(3_600_000) },
        now,
      ),
    ).toBe("running");
  });

  it("koşu açık ama ilerleme yok → ilerlemiyor", () => {
    expect(
      classificationRunStatus(
        checkpoint(STALL_AFTER_MS + 60_000),
        { status: "running", startedAt: ago(STALL_AFTER_MS + 120_000) },
        now,
      ),
    ).toBe("stalled");
  });

  it("yeni başlayan koşu (henüz kontrol noktası yok) çalışıyor sayılır", () => {
    expect(classificationRunStatus(null, { status: "running", startedAt: ago(10_000) }, now)).toBe(
      "running",
    );
  });

  it("tamamlandı / duraklatıldı / başarısız", () => {
    expect(
      classificationRunStatus(
        checkpoint(1_000, true),
        { status: "success", startedAt: ago(5_000) },
        now,
      ),
    ).toBe("completed");
    expect(
      classificationRunStatus(checkpoint(1_000), { status: "partial", startedAt: ago(5_000) }, now),
    ).toBe("paused");
    expect(
      classificationRunStatus(checkpoint(1_000), { status: "failed", startedAt: ago(5_000) }, now),
    ).toBe("failed");
  });
});
