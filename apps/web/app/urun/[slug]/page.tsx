import {
  compareMerchants,
  findAlternatives,
  getColorVariants,
  getPriceHistory,
  getPriceStats,
  getSizeOptions,
  isProductSitemapEligible,
  readAppUrl,
  resolveProductSlug,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import {
  ColorSwatches,
  formatTRY,
  ListPriceNote,
  MerchantList,
  PriceChart,
  PriceDiffBlock,
  PricePositionText,
  ProductCard,
  UpdatedAt,
} from "@arilla/ui";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { ProductActionsClient } from "./product-actions-client.tsx";
import { SizeSelectorClient } from "./size-selector-client.tsx";

/** docs/copy.md `product.price_lowest_90d`: yalnizca gercekten dusukse gosterilir. */
const LOWEST_PERCENTILE_THRESHOLD = 5;

function formatSure(from: Date, now: Date): string {
  const minutes = Math.max(1, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} dakika`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} saat`;
  return `${Math.floor(hours / 24)} gün`;
}

/** `generateMetadata` ve sayfa bileşeni ayni istekte ayni sluğu iki kez çözmesin. */
const getResolution = cache((slug: string) => resolveProductSlug(getDatabase(), slug));

/**
 * D6: docs/sitemap.md "Hangi sayfa haritaya girer" - eşiği geçmeyen ürün
 * `noindex` alır ama sayfa yayında kalır (docs/sitemap.md: "Şartı sağlamayan
 * sayfa yayında kalır ama haritaya girmez ve noindex alır").
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const resolution = await getResolution(slug);
  if (resolution.status !== "found") return {};

  const { product } = resolution;
  const eligible = await isProductSitemapEligible(getDatabase(), product.productId);

  // docs/copy.md `seo.product_title` / `seo.product_title_no_brand` / `seo.product_description`
  const title = product.brandName
    ? `${product.title} – ${product.brandName} fiyat karşılaştırma`
    : `${product.title} fiyat karşılaştırma`;
  const description = `${product.title} fiyatlarını karşılaştır, en uygun fiyatlı mağazayı bul.`;

  return {
    title,
    description,
    alternates: { canonical: `/urun/${product.slug}` },
    ...(eligible ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDatabase();

  const resolution = await getResolution(slug);
  if (resolution.status === "not_found") {
    notFound();
  }
  if (resolution.status === "redirect") {
    permanentRedirect(`/urun/${resolution.canonicalSlug}`);
  }

  const { product } = resolution;

  const [merchantOffers, alternatives, sizeOptions, priceStats] = await Promise.all([
    compareMerchants(db, product.productId),
    findAlternatives(db, product.productId),
    getSizeOptions(db, product.productId),
    getPriceStats(db, product.productId),
  ]);

  const colorVariants = product.modelKey
    ? await getColorVariants(db, product.modelKey, product.productId)
    : [];
  const priceHistory =
    merchantOffers.length > 0 ? await getPriceHistory(db, product.productId) : [];

  const cheapest = merchantOffers[0];
  const singleOffer = merchantOffers.length === 1;

  const positionLines: string[] = [];
  if (
    priceStats &&
    priceStats.currentPercentile !== null &&
    priceStats.currentPercentile <= LOWEST_PERCENTILE_THRESHOLD
  ) {
    positionLines.push("Son 90 günün en düşük fiyatı");
  }
  if (priceStats && priceStats.dropCount90d !== null && priceStats.dropCount90d > 0) {
    positionLines.push(`Son 3 ayda ${priceStats.dropCount90d} kez daha uygun fiyatlıydı`);
  }

  const now = new Date();
  const listPriceNoteText =
    priceStats?.listPriceInflated && priceStats.listPriceRaisedAt && cheapest?.listPrice
      ? `Liste fiyatı ${formatSure(priceStats.listPriceRaisedAt, now)} önce ${formatTRY(cheapest.listPrice)} idi.`
      : null;

  // docs/routes.md "Teknik kurallar": Product ve Offer yapılandırılmış verisi.
  // schema.org `url` mutlak olmalı - APP_URL yoksa alan tamamen atlanır,
  // göreli bir URL yazmaktan iyidir (Rich Results Test göreli url'i reddeder).
  const siteUrl = readAppUrl();
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    ...(product.brandName ? { brand: { "@type": "Brand", name: product.brandName } } : {}),
    ...(product.primaryImageUrl ? { image: [product.primaryImageUrl] } : {}),
    ...(siteUrl ? { url: `${siteUrl}/urun/${product.slug}` } : {}),
    ...(merchantOffers.length > 0
      ? {
          offers: merchantOffers.map((offer) => ({
            "@type": "Offer",
            price: (offer.currentPrice / 100).toFixed(2),
            priceCurrency: "TRY",
            availability: offer.inStock
              ? "https://schema.org/InStock"
              : "https://schema.org/OutOfStock",
            ...(siteUrl ? { url: `${siteUrl}/git/${offer.offerId}?surface=structured_data` } : {}),
          })),
        }
      : {}),
  };

  return (
    <main style={{ padding: 24, display: "grid", gap: 24, maxWidth: 720 }}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: schema.org JSON-LD, kullanici girdisi degil - sunucu tarafinda kendi verimizden uretiliyor.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }}
      />

      {/* 1. Ürün görseli */}
      {product.primaryImageUrl ? (
        // biome-ignore lint/performance/noImgElement: ProductCard.tsx ile ayni desen, keyfi merchant host'lari icin next/image remotePatterns pratik degil.
        <img
          src={product.primaryImageUrl}
          alt={product.title}
          style={{
            width: "100%",
            aspectRatio: "1 / 1",
            objectFit: "cover",
            background: "var(--surface)",
          }}
        />
      ) : (
        <div
          style={{ width: "100%", aspectRatio: "1 / 1", background: "var(--surface)" }}
          aria-hidden="true"
        />
      )}

      {/* 2. Başlık, marka */}
      <div>
        <h1 style={{ margin: 0 }}>{product.title}</h1>
        {product.brandName ? (
          <p style={{ margin: 0, color: "var(--ink-muted)" }}>{product.brandName}</p>
        ) : null}
      </div>

      {/* 3. Fiyat farkı bloğu */}
      {cheapest ? (
        <PriceDiffBlock
          currentPriceKurus={cheapest.currentPrice}
          listPriceKurus={cheapest.listPrice}
          savingLabel={(saving) => `${formatTRY(saving)} tasarruf`}
        />
      ) : null}

      {/* 4. Fiyat konumu cümlesi */}
      <PricePositionText lines={positionLines} />

      {/* 5. Sahte indirim notu */}
      {listPriceNoteText ? <ListPriceNote text={listPriceNoteText} /> : null}

      {/* 6. Beden seçici + rozet */}
      <SizeSelectorClient
        productId={product.productId}
        sizes={sizeOptions.map((size) => ({
          sizeNorm: size.sizeNorm,
          label: size.sizeLabel ?? size.sizeNorm,
          available: size.inStock,
        }))}
      />

      {/* 7. Mağaza listesi - tek teklif varsa atlanır (pages.md), noindex D6'nın işi */}
      {!singleOffer && merchantOffers.length > 0 ? (
        <>
          <MerchantList
            offers={merchantOffers.map((offer) => ({
              offerId: offer.offerId,
              merchantName: offer.merchantName,
              totalLabel: formatTRY(offer.effectiveTotal),
              shippingLabel:
                offer.effectiveShipping === 0
                  ? "Kargo bedava"
                  : `Kargo dahil ${formatTRY(offer.effectiveTotal)}`,
              inStock: offer.inStock,
              exitHref: `/git/${offer.offerId}?surface=compare`,
              exitLabel: `${offer.merchantName}'da aç`,
            }))}
            outOfStockLabel="Şu an stokta yok"
          />
          <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>
            Bazı bağlantılardan alışveriş yaptığında komisyon kazanabiliriz. Bu, sana gösterdiğimiz
            fiyatı değiştirmez.
          </p>
          <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>
            Fiyat ve stok bilgisi mağazalardan alınır, gecikmeli olabilir.
          </p>
        </>
      ) : null}

      {/* 8. Kaydet / alarm kur */}
      <ProductActionsClient
        productId={product.productId}
        isInStock={merchantOffers.some((offer) => offer.inStock)}
        currentPriceTRY={cheapest ? Math.floor(cheapest.currentPrice / 100) : null}
      />

      {/* 9. Diğer renkler */}
      <ColorSwatches
        variants={colorVariants.map((variant) => ({
          href: `/urun/${variant.slug}`,
          color: variant.color ?? "",
          imageUrl: variant.primaryImageUrl,
        }))}
        label="Diğer renkler"
      />

      {/* 10. Alternatif şeridi */}
      {alternatives.length > 0 ? (
        <div>
          <p>Daha uygun fiyatlı alternatifler</p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 16,
            }}
          >
            {alternatives.map((alt) => (
              // AlternativeProduct'ta offerCount yok (C2 kapsami) - bos etiketle atlanir.
              <ProductCard
                key={alt.productId}
                href={`/urun/${alt.slug}`}
                title={alt.title}
                imageUrl={alt.primaryImageUrl}
                minPrice={alt.minPrice}
                offerCount={0}
                offerCountLabel={() => ""}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* 11. Fiyat grafiği - katlanmış, tıklayınca açılır */}
      <PriceChart
        points={priceHistory.map((point) => ({
          date: point.date,
          priceKurus: point.minPriceKurus,
        }))}
        summaryLabel="Fiyat geçmişi"
      />

      {/* 12. Son güncelleme */}
      {product.priceUpdatedAt ? (
        <UpdatedAt text={`${formatSure(product.priceUpdatedAt, now)} önce güncellendi`} />
      ) : null}
    </main>
  );
}
