import { getTrendBySlug } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { FallbackImage, ProductCard, Section } from "@arilla/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { offerCountLabel } from "../../ara/search-results.tsx";
import { requireProductAccess } from "../../lib/dal.ts";
import { TREND_COPY, trendProductCountLabel } from "../trend-copy.ts";
import { isTrendSlug } from "../trend-slug.ts";
import styles from "../trendler.module.css";

/** `generateMetadata` ve sayfa ayni istekte ayni trendi iki kez okumasin. */
const getTrend = cache(async (slug: string) =>
  isTrendSlug(slug) ? getTrendBySlug(getDatabase(), slug) : null,
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  // Kapali urunun basligi/aciklamasi da sizmasin: meta veri de kapidan gecer.
  await requireProductAccess();
  const { slug } = await params;
  const detail = await getTrend(slug);
  if (!detail) return {};
  // Koleksiyon sayfasi: Article/BlogPosting yapisal verisi YOK (urun listesi, makale degil).
  return {
    title: `${detail.trend.title} – Arilla`,
    description: detail.trend.description,
    alternates: { canonical: `/trendler/${detail.trend.slug}` },
  };
}

/** Ilk ekrandaki (mobilde ilk iki satir) gorseller gecikmeden yuklenir. */
const EAGER_PRODUCT_COUNT = 4;

/**
 * `/trendler/<slug>`: kisa kapak (geri baglantisi, baslik, tek cumle aciklama)
 * ve dogrudan urun izgarasi. Makale/blog govdesi YOKTUR. Urun karti mevcut
 * `ProductCard`; tiklama `/urun/<slug>` fiyat karsilastirma sayfasina gider.
 * Gecersiz/yayinlanmamis/yeterli urunu olmayan trend 404.
 */
export default async function TrendDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireProductAccess();
  const { slug } = await params;
  const detail = await getTrend(slug);
  if (!detail) notFound();

  const { trend, products } = detail;
  return (
    <Section aria-labelledby="trend-baslik">
      <div className={styles.detail}>
        <a href="/trendler" className={styles.back} aria-label={TREND_COPY.backAria}>
          <span aria-hidden="true">←</span> {TREND_COPY.back}
        </a>
        <div className={styles.heroMedia}>
          {/* Kirik gorselde siradaki adayi dener; hepsi kirikse yer tutucu (`FallbackImage`). */}
          <FallbackImage
            srcs={trend.heroCandidates}
            alt=""
            className={styles.heroImage}
            placeholderClassName={styles.heroPlaceholder}
            fit="contain"
            loading="eager"
            fetchPriority="high"
          />
        </div>
        <div className={styles.heroText}>
          <h1 id="trend-baslik" className={styles.heroTitle}>
            {trend.title}
          </h1>
          <p className={styles.heroDescription}>{trend.description}</p>
          <p className={styles.heroMeta}>{trendProductCountLabel(trend.productCount)}</p>
        </div>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
        <ul role="list" className={styles.products} aria-label={TREND_COPY.productsHeading}>
          {products.map((item, index) => (
            <li key={item.productId} className={styles.productItem}>
              <ProductCard
                href={`/urun/${item.slug}`}
                title={item.title}
                brand={item.brandName}
                imageUrl={item.primaryImageUrl}
                imageLoading={index < EAGER_PRODUCT_COUNT ? "eager" : "lazy"}
                minPrice={item.minPrice}
                priceFrom={item.priceFromVariants}
                offerCount={item.offerCount}
                offerCountLabel={offerCountLabel}
              />
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
