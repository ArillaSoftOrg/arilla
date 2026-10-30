import { SITE_BRAND } from "../site-config.ts";
import { TREND_COPY } from "./trend-copy.ts";

/**
 * `/trendler/<slug>` yapilandirilmis verisi: `BreadcrumbList` + `ItemList`.
 *
 * - Koleksiyon bir makale degildir (karar 0077): `Article`/`BlogPosting` yok.
 * - `ItemList` yalnizca sayfanin cizdigi urunleri, AYNI sirayla tasir (konum, ad,
 *   urun sayfasi adresi). Fiyat, marka, stok, puan ya da degerlendirme YAZILMAZ:
 *   o bilgiler urun sayfasinin kendi `Product` verisindedir; burada uydurulmaz.
 * - schema.org adresleri mutlak olmalidir; site adresi yoksa veri hic uretilmez
 *   (urun sayfasindaki `url` kuraliyla ayni).
 * - Cikti `serializeJsonLd` ile yazilir (`</script>` kacisi).
 */

export interface TrendJsonLdInput {
  siteUrl: string | undefined;
  trend: { slug: string; title: string };
  /** Sayfadaki izgaranin urunleri, gosterim sirasinda. */
  products: readonly { slug: string; title: string }[];
}

function absolute(siteUrl: string, path: string): string {
  return new URL(path, `${siteUrl}/`).toString();
}

/** Urun ve trend adresleri: her kesim yuzde-kodlanir (slug zaten guvenli bicimde olsa da). */
export function trendPath(slug: string): string {
  return `/trendler/${encodeURIComponent(slug)}`;
}

function productPath(slug: string): string {
  return `/urun/${encodeURIComponent(slug)}`;
}

export function trendJsonLd(input: TrendJsonLdInput): Record<string, unknown>[] {
  if (!input.siteUrl) return [];
  const site = input.siteUrl;
  const pageUrl = absolute(site, trendPath(input.trend.slug));
  return [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE_BRAND, item: absolute(site, "/") },
        {
          "@type": "ListItem",
          position: 2,
          name: TREND_COPY.pageTitle,
          item: absolute(site, "/trendler"),
        },
        { "@type": "ListItem", position: 3, name: input.trend.title, item: pageUrl },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: input.trend.title,
      url: pageUrl,
      numberOfItems: input.products.length,
      itemListElement: input.products.map((product, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: product.title,
        url: absolute(site, productPath(product.slug)),
      })),
    },
  ];
}
