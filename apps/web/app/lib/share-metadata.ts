import type { Metadata } from "next";
import { SITE_BRAND } from "../site-config.ts";

/**
 * Paylaşım önizlemesi (Open Graph + Twitter Card) - ürün ve trend sayfaları.
 *
 * Kurallar:
 * - Görsel sayfanın gösterdiği gerçek görseldir (ürün galerisinin ilki, trendin
 *   kapağı). Görsel üretilmez: `next/og` Türkçe glif için Google Fonts çeker
 *   (karar 0009), kök layout bu yüzden OG görseli tanımlamaz.
 * - Yalnızca mutlak, `https`, kimlik bilgisi taşımayan adres kabul edilir;
 *   değilse mevcut site ikonuna düşülür. Sahte ürün görseli gösterilmez.
 * - Fiyat yazılmaz: önizlemeler platformlarda günlerce önbellekte kalır, fiyat
 *   bayatlar (doğrulanamayan fiyat gösterilmez, karar 0156).
 * - `openGraph` iç içe birleşmez, kökün yerine geçer: `siteName`/`locale` tekrar verilir.
 */

/** `app/icon4.png` (512x512): mevcut site ikonu, yeni görsel değil. */
export const SITE_SHARE_IMAGE = { path: "/icon4.png", width: 512, height: 512 } as const;

/** Paylaşım görseli adresinin üst sınırı; daha uzunu platformlarca kesilir. */
const MAX_IMAGE_URL_LENGTH = 2048;

export interface ShareImageInput {
  url: string | null | undefined;
  width?: number | null;
  height?: number | null;
}

/** Önizlemede kullanılabilir mutlak `https` adres; değilse null. */
export function safeShareImageUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > MAX_IMAGE_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  return parsed.toString();
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

interface ShareCardInput {
  /** `<title>` ve paylaşım başlığı. */
  title: string;
  description: string;
  /** Kök göreli yol ("/urun/x"); `metadataBase` ile mutlak olur. */
  path: string;
  /** Görsel alt metni (ürün/koleksiyon adı). */
  imageAlt: string;
  image: ShareImageInput | null;
  /** Site adresi tanımlı mı: değilse site ikonu göreli kalacağı için hiç verilmez. */
  hasSiteUrl: boolean;
}

function shareCard(input: ShareCardInput): Pick<Metadata, "openGraph" | "twitter"> {
  const url = safeShareImageUrl(input.image?.url);
  const width = positive(input.image?.width);
  const height = positive(input.image?.height);
  const image = url
    ? {
        url,
        alt: input.imageAlt,
        ...(width && height ? { width, height } : {}),
      }
    : input.hasSiteUrl
      ? {
          url: SITE_SHARE_IMAGE.path,
          width: SITE_SHARE_IMAGE.width,
          height: SITE_SHARE_IMAGE.height,
          alt: SITE_BRAND,
        }
      : null;

  return {
    openGraph: {
      siteName: SITE_BRAND,
      locale: "tr_TR",
      type: "website",
      title: input.title,
      description: input.description,
      url: input.path,
      ...(image ? { images: [image] } : {}),
    },
    twitter: {
      // Kare site ikonu büyük kartta kırpılır; yalnız gerçek içerik görseli büyük kart.
      card: url ? "summary_large_image" : "summary",
      title: input.title,
      description: input.description,
      ...(image ? { images: [{ url: image.url, alt: image.alt }] } : {}),
    },
  };
}

export interface ProductShareInput {
  slug: string;
  title: string;
  brandName: string | null;
  /** Galerinin ilk görseli (sayfa hero'su ve JSON-LD ile aynı). */
  image: ShareImageInput | null;
  hasSiteUrl: boolean;
}

/** docs/copy.md `seo.product_title` / `seo.product_title_no_brand` / `seo.product_description`. */
export function productShareMetadata(input: ProductShareInput): Metadata {
  const title = input.brandName
    ? `${input.title} – ${input.brandName} fiyat karşılaştırma`
    : `${input.title} fiyat karşılaştırma`;
  const description = `${input.title} fiyatlarını karşılaştır, en uygun fiyatlı mağazayı bul.`;
  const path = `/urun/${input.slug}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    ...shareCard({
      title,
      description,
      path,
      imageAlt: input.title,
      image: input.image,
      hasSiteUrl: input.hasSiteUrl,
    }),
  };
}

export interface TrendShareInput {
  slug: string;
  title: string;
  description: string;
  /** Sayfanın çözdüğü kapak: trendin kendi görseli, yoksa temsilci ürünün görseli. */
  heroImageUrl: string | null;
  hasSiteUrl: boolean;
}

export function trendShareMetadata(input: TrendShareInput): Metadata {
  const path = `/trendler/${input.slug}`;
  return {
    title: `${input.title} – Arilla`,
    description: input.description,
    alternates: { canonical: path },
    ...shareCard({
      // `og:site_name` markayı zaten taşır; başlıkta tekrarlanmaz.
      title: input.title,
      description: input.description,
      path,
      imageAlt: input.title,
      image: { url: input.heroImageUrl },
      hasSiteUrl: input.hasSiteUrl,
    }),
  };
}
