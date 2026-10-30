import { describe, expect, it } from "vitest";
import {
  productShareMetadata,
  SITE_SHARE_IMAGE,
  safeShareImageUrl,
  trendShareMetadata,
} from "./share-metadata.ts";

const IMAGE = "https://cdn.magaza.example/urun/1.jpg";

function product(overrides: Partial<Parameters<typeof productShareMetadata>[0]> = {}) {
  return productShareMetadata({
    slug: "kosu-ayakkabisi",
    title: "Koşu ayakkabısı",
    brandName: "Marka",
    image: { url: IMAGE, width: 800, height: 1000 },
    hasSiteUrl: true,
    ...overrides,
  });
}

describe("safeShareImageUrl", () => {
  it("yalnız mutlak https adresi kabul eder", () => {
    expect(safeShareImageUrl(IMAGE)).toBe(IMAGE);
    expect(safeShareImageUrl(`  ${IMAGE}  `)).toBe(IMAGE);
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "http://cdn.magaza.example/1.jpg",
      "/goreli.jpg",
      "//cdn.magaza.example/1.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://kullanici:sifre@cdn.magaza.example/1.jpg",
      `https://cdn.magaza.example/${"a".repeat(2100)}.jpg`,
    ]) {
      expect([bad, safeShareImageUrl(bad)]).toEqual([bad, null]);
    }
  });
});

describe("productShareMetadata", () => {
  it("başlık, açıklama, kanonik adres ve önizleme aynı metni taşır", () => {
    const meta = product();
    expect(meta.title).toBe("Koşu ayakkabısı – Marka fiyat karşılaştırma");
    expect(meta.description).toBe(
      "Koşu ayakkabısı fiyatlarını karşılaştır, en uygun fiyatlı mağazayı bul.",
    );
    expect(meta.alternates).toEqual({ canonical: "/urun/kosu-ayakkabisi" });
    expect(meta.openGraph).toMatchObject({
      siteName: "ManiCepte",
      locale: "tr_TR",
      type: "website",
      title: meta.title,
      description: meta.description,
      url: "/urun/kosu-ayakkabisi",
      images: [{ url: IMAGE, width: 800, height: 1000, alt: "Koşu ayakkabısı" }],
    });
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: [{ url: IMAGE, alt: "Koşu ayakkabısı" }],
    });
  });

  it("markasız ürün copy.md `seo.product_title_no_brand` kalıbını kullanır", () => {
    expect(product({ brandName: null }).title).toBe("Koşu ayakkabısı fiyat karşılaştırma");
  });

  it("boyut bilinmiyorsa ya da geçersizse boyut yazılmaz", () => {
    for (const size of [
      { width: null, height: null },
      { width: 800, height: null },
      { width: 0, height: 600 },
      { width: 1.5, height: 600 },
    ]) {
      const images = product({ image: { url: IMAGE, ...size } }).openGraph?.images;
      expect(images).toEqual([{ url: IMAGE, alt: "Koşu ayakkabısı" }]);
    }
  });

  it("görselsiz ürün sahte görsel değil, mevcut site ikonunu küçük kartla alır", () => {
    for (const image of [null, { url: null }, { url: "http://guvensiz.example/1.jpg" }]) {
      const meta = product({ image });
      expect(meta.openGraph?.images).toEqual([
        {
          url: SITE_SHARE_IMAGE.path,
          width: SITE_SHARE_IMAGE.width,
          height: SITE_SHARE_IMAGE.height,
          alt: "ManiCepte",
        },
      ]);
      expect(meta.twitter).toMatchObject({ card: "summary" });
    }
  });

  it("site adresi yoksa göreli ikon yazılmaz (mutlak olamaz)", () => {
    const meta = product({ image: null, hasSiteUrl: false });
    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).not.toHaveProperty("images");
    expect(meta.twitter).toMatchObject({ card: "summary" });
  });

  it("önizlemede fiyat ya da para birimi geçmez", () => {
    const text = JSON.stringify(product());
    expect(text).not.toMatch(/₺|TL\b|TRY|fiyatı \d/);
  });
});

describe("trendShareMetadata", () => {
  const base = {
    slug: "kis-montlari",
    title: "Kış montları",
    description: "Soğuk günler için seçtiklerimiz.",
    heroImageUrl: IMAGE,
    hasSiteUrl: true,
  };

  it("sayfa başlığı korunur; önizleme başlığı marka eki taşımaz", () => {
    const meta = trendShareMetadata(base);
    expect(meta.title).toBe("Kış montları – Arilla");
    expect(meta.alternates).toEqual({ canonical: "/trendler/kis-montlari" });
    expect(meta.openGraph).toMatchObject({
      siteName: "ManiCepte",
      locale: "tr_TR",
      title: "Kış montları",
      description: base.description,
      url: "/trendler/kis-montlari",
      images: [{ url: IMAGE, alt: "Kış montları" }],
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", title: "Kış montları" });
  });

  it("kapaksız koleksiyon site ikonuna düşer", () => {
    const meta = trendShareMetadata({ ...base, heroImageUrl: null });
    expect(meta.openGraph?.images).toEqual([
      expect.objectContaining({ url: SITE_SHARE_IMAGE.path }),
    ]);
    expect(meta.twitter).toMatchObject({ card: "summary" });
  });
});
