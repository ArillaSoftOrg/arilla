import {
  alertSizeNormForVariant,
  type ComparisonRow,
  findAlternatives,
  getColorVariants,
  getPriceHistory,
  getPriceStats,
  getProductPriceComparison,
  getSizeOptions,
  getVariantPriceHistory,
  isProductSitemapEligible,
  readAppUrl,
  resolveProductSlug,
  serializeJsonLd,
  variantLowestClaim,
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
  ProductImage,
  Section,
  UpdatedAt,
  withLocativeSuffix,
} from "@arilla/ui";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { HOME_COPY } from "../../home-copy.ts";
import { ProductActionsClient } from "./product-actions-client.tsx";
import styles from "./product-page.module.css";
import { SizeSelectorClient } from "./size-selector-client.tsx";
import { VariantRestockClient } from "./variant-restock-client.tsx";

/** docs/copy.md `product.unit_price`: birim fiyat tamamlayıcıdır, fiyatın yerine geçmez. */
function unitPriceLabel(row: ComparisonRow): string | undefined {
  return row.unitPriceKurus !== null && row.unitLabel
    ? `${row.unitLabel}: ${formatTRY(row.unitPriceKurus)}`
    : undefined;
}

function variantOfferCountFor(rows: readonly { offerId: number }[]): number {
  return new Set(rows.map((row) => row.offerId)).size;
}

/** `?boyut=` degeri: tek bir dize, yoksa null. */
function readSelectedVariant(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ? raw.trim() : null;
}

/** Mağaza satırı ve birincil çıkışın ortak metinleri (docs/copy.md `product.*`). */
interface OfferLike {
  merchantName: string;
  effectiveShipping: number;
  effectiveTotal: number;
}

/** docs/copy.md `action.open_at_merchant`: "{mağaza}'da aç", ek ünlü uyumuyla. */
function openAtMerchantLabel(offer: OfferLike): string {
  return `${withLocativeSuffix(offer.merchantName)} aç`;
}

/** Liste satırı: kargo dahil toplam ayrı sütunda durur, burada yalnızca kargo payı. */
function offerShippingLabel(offer: OfferLike): string {
  return offer.effectiveShipping === 0
    ? "Kargo bedava"
    : `${formatTRY(offer.effectiveShipping)} kargo`;
}

/** Birincil çıkış: başlıktaki fiyat kargosuz ürün fiyatıdır, burada kargo dahil toplam. */
function offerTotalLabel(offer: OfferLike): string {
  return offer.effectiveShipping === 0
    ? "Kargo bedava"
    : `Kargo dahil ${formatTRY(offer.effectiveTotal)}`;
}

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

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ boyut?: string | string[] }>;
}) {
  const { slug } = await params;
  const requestedVariant = readSelectedVariant((await searchParams).boyut);
  const db = getDatabase();

  const resolution = await getResolution(slug);
  if (resolution.status === "not_found") {
    notFound();
  }
  if (resolution.status === "redirect") {
    permanentRedirect(`/urun/${resolution.canonicalSlug}`);
  }

  const { product } = resolution;

  const [{ merchantOffers, comparison }, alternatives, sizeOptions, priceStats] = await Promise.all(
    [
      getProductPriceComparison(db, product.productId, requestedVariant),
      findAlternatives(db, product.productId),
      getSizeOptions(db, product.productId),
      getPriceStats(db, product.productId),
    ],
  );

  const colorVariants = product.modelKey
    ? await getColorVariants(db, product.modelKey, product.productId)
    : [];
  // Basit modda urun gecmisi; varyant modunda YALNIZCA secili varyantin
  // gecmisi (0037). Secim yoksa gecmis yok: boyutlar karismaz.
  const variantHistory =
    comparison.mode === "variants" && comparison.selectedKey
      ? await getVariantPriceHistory(db, product.productId, comparison.selectedKey)
      : null;
  const priceHistory =
    comparison.mode === "variants"
      ? (variantHistory?.points ?? [])
      : merchantOffers.length > 0
        ? await getPriceHistory(db, product.productId)
        : [];

  // docs/decisions/0033: teklifler farkli ticari varyantlar (60 ml / 100 ml)
  // satiyorsa fiyatlar yalnizca SECILI varyant icinde karsilastirilir. Basit
  // modda (varyant fiyati etkilemiyor) eski akis aynen gecerli.
  const variantMode = comparison.mode === "variants" ? comparison : null;
  const cheapest = merchantOffers[0];
  // compareMerchants yalnizca kargo dahil toplama gore siralar (stok bilmez).
  // Birincil cikis ve "En uygun fiyat" etiketi stokta olan en uygun teklife
  // gider; hic stokta teklif yoksa en uygun teklif kalir.
  const primaryOffer = merchantOffers.find((offer) => offer.inStock) ?? cheapest;
  const singleOffer = merchantOffers.length === 1;

  const positionLines: string[] = [];
  // Urun duzeyi fiyat istatistigi boyutlari karistirir; varyant modunda
  // "son 90 gunun en dusugu" iddiasi hangi boyut icin oldugunu bilmez.
  if (
    !variantMode &&
    priceStats &&
    priceStats.currentPercentile !== null &&
    priceStats.currentPercentile <= LOWEST_PERCENTILE_THRESHOLD
  ) {
    positionLines.push("Son 90 günün en düşük fiyatı");
  }
  if (
    !variantMode &&
    priceStats &&
    priceStats.dropCount90d !== null &&
    priceStats.dropCount90d > 0
  ) {
    positionLines.push(`Son 3 ayda ${priceStats.dropCount90d} kez daha uygun fiyatlıydı`);
  }

  const now = new Date();
  if (
    variantMode?.best &&
    variantHistory &&
    variantLowestClaim(variantHistory, variantMode.best.priceKurus, now)
  ) {
    positionLines.push("Son 90 günün en düşük fiyatı");
  }
  const listPriceNoteText =
    !variantMode &&
    priceStats?.listPriceInflated &&
    priceStats.listPriceRaisedAt &&
    cheapest?.listPrice
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
    ...(variantMode && !variantMode.selectedKey && variantMode.rows.length > 0
      ? {
          // 0037: secim yokken teklifler FARKLI boyutlardir; tek "esdeger
          // teklif" kumesi gibi degil, bir fiyat ARALIGI olarak bildirilir.
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "TRY",
            lowPrice: (Math.min(...variantMode.rows.map((r) => r.priceKurus)) / 100).toFixed(2),
            highPrice: (Math.max(...variantMode.rows.map((r) => r.priceKurus)) / 100).toFixed(2),
            offerCount: variantOfferCountFor(variantMode.rows),
          },
        }
      : variantMode
        ? {
            // Secili varyant: yalnizca uyumlu satirlar (hepsi ayni boyut).
            offers: variantMode.rows.map((row) => ({
              "@type": "Offer",
              ...(row.variantLabel ? { name: row.variantLabel } : {}),
              price: (row.priceKurus / 100).toFixed(2),
              priceCurrency: "TRY",
              availability: row.inStock
                ? "https://schema.org/InStock"
                : "https://schema.org/OutOfStock",
              ...(siteUrl ? { url: `${siteUrl}/git/${row.offerId}?surface=structured_data` } : {}),
            })),
          }
        : merchantOffers.length > 0
          ? {
              offers: merchantOffers.map((offer) => ({
                "@type": "Offer",
                price: (offer.currentPrice / 100).toFixed(2),
                priceCurrency: "TRY",
                availability: offer.inStock
                  ? "https://schema.org/InStock"
                  : "https://schema.org/OutOfStock",
                ...(siteUrl
                  ? { url: `${siteUrl}/git/${offer.offerId}?surface=structured_data` }
                  : {}),
              })),
            }
          : {}),
  };

  // Fiyat geçmişi özeti: grafikle aynı seriden (decision 0019, son 90 gün).
  const historyPrices = priceHistory.map((point) => point.minPriceKurus);
  const historyMin = historyPrices.length > 0 ? Math.min(...historyPrices) : null;
  const historyMax = historyPrices.length > 0 ? Math.max(...historyPrices) : null;
  const historySentence =
    historyMin === null || historyMax === null
      ? null
      : historyMin === historyMax
        ? `Son 90 günde fiyat ${formatTRY(historyMin)} olarak kaldı.`
        : `Son 90 günde ${formatTRY(historyMin)} ile ${formatTRY(historyMax)} arasında değişti.`;

  const showOffers = !singleOffer && merchantOffers.length > 0;
  // Gecmis grafigi gunluk en dusugu tum boyutlardan alir: varyant modunda
  // yaniltici olur, gizlenir (varyant bazli gecmis henuz yok).
  // Grafik en az iki GERCEK gunle cizilir; varyant modunda yalnizca secili
  // varyantin gecmisi (0037). Nokta sentezlenmez.
  const showHistory = priceHistory.length >= 2;
  const historyCoverageNote =
    variantHistory && !variantHistory.complete && variantHistory.compatibleOfferCount > 0
      ? `Geçmiş, bu boyutu satan ${variantHistory.compatibleOfferCount} mağazanın ${variantHistory.contributingOfferCount} tanesinin verisini içeriyor.`
      : null;
  const variantBest = variantMode?.best ?? null;
  const variantFieldLabel = variantMode?.options.every((option) => option.key.startsWith("beden:"))
    ? "Beden"
    : "Boyut";
  const selectedOption = variantMode?.options.find((o) => o.key === variantMode.selectedKey);
  const variantRows = variantMode?.rows ?? [];
  const variantOfferCount = new Set(variantRows.map((row) => row.offerId)).size;

  return (
    <div className={styles.page}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: schema.org JSON-LD; baslik merchant feed'inden gelir, serializeJsonLd </script> kacisini engeller.
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd) }}
      />

      <div className={styles.hero}>
        {/* 1. Ürün görseli */}
        <div className={styles.media}>
          <div className={styles.mediaFrame}>
            {product.primaryImageUrl ? (
              <ProductImage
                src={product.primaryImageUrl}
                alt={product.title}
                // LCP: ürün görseli ilk ekranda - lazy değil, yüksek öncelikli.
                loading="eager"
                fetchPriority="high"
                fit="contain"
                className={styles.image}
              />
            ) : (
              <div className={styles.mediaPlaceholder} aria-hidden="true" />
            )}
          </div>
        </div>

        <div className={styles.summary}>
          {/* 2. Marka, başlık */}
          <div className={styles.titleBlock}>
            {product.brandName ? <p className={styles.brand}>{product.brandName}</p> : null}
            <h1 className={styles.title}>{product.title}</h1>
          </div>

          <div className={styles.priceBlock}>
            {/* 3. Fiyat farkı bloğu. Varyant modunda: seçili varyantın en uygun
                teklifi; seçim yoksa karşılaştırma değil "Başlangıç fiyatı". */}
            {variantMode ? (
              variantBest && selectedOption ? (
                <>
                  <PriceDiffBlock
                    currentPriceKurus={variantBest.priceKurus}
                    listPriceKurus={variantBest.listPriceKurus}
                    savingLabel={(saving) => `${formatTRY(saving)} tasarruf`}
                    listPriceLabel="Liste fiyatı"
                    currentPriceLabel={`En uygun teklif, ${selectedOption.label}`}
                  />
                  {unitPriceLabel(variantBest) ? (
                    <p className={styles.variantHint}>{unitPriceLabel(variantBest)}</p>
                  ) : null}
                </>
              ) : (
                <div className={styles.startingPrice}>
                  <p className={styles.startingLabel}>Başlangıç fiyatı</p>
                  <p className={styles.startingValue}>
                    {formatTRY(variantMode.startingPriceKurus)}
                  </p>
                  <p className={styles.variantHint}>
                    {variantMode.selectedMissing
                      ? `Seçtiğin ${variantFieldLabel.toLocaleLowerCase("tr-TR")} şu an hiçbir mağazada yok. Başka bir seçenek dene.`
                      : `Fiyat ${variantFieldLabel.toLocaleLowerCase("tr-TR")} seçimine göre değişir. Karşılaştırmak için bir seçenek seç.`}
                  </p>
                </div>
              )
            ) : cheapest ? (
              <PriceDiffBlock
                currentPriceKurus={cheapest.currentPrice}
                listPriceKurus={cheapest.listPrice}
                savingLabel={(saving) => `${formatTRY(saving)} tasarruf`}
                listPriceLabel="Liste fiyatı"
                currentPriceLabel="En uygun teklif"
              />
            ) : (
              <p className={styles.noOffers}>Şu an bu ürün için mağaza fiyatı yok.</p>
            )}

            {/* 4. Fiyat konumu cümlesi */}
            <PricePositionText lines={positionLines} />

            {/* 5. Sahte indirim notu */}
            {listPriceNoteText ? <ListPriceNote text={listPriceNoteText} /> : null}

            {/* 12. Son güncelleme - design.md: "Fiyatın yanında güncellenme zamanı yazılır". */}
            {product.priceUpdatedAt ? (
              <UpdatedAt text={`${formatSure(product.priceUpdatedAt, now)} önce güncellendi`} />
            ) : null}
          </div>

          {/* Birincil çıkış: stokta olan en uygun teklif (tek teklifte o teklif).
              Mağaza listesi tek teklifte gizlendiği için (pages.md) görünen çıkış budur. */}
          {/* Varyant modu: seçim + birincil çıkış yalnızca uyumlu teklife. */}
          {variantMode ? (
            <div className={styles.fieldGroup}>
              <p id="varyant-baslik" className={styles.fieldLabel}>
                {variantFieldLabel}
              </p>
              {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolunu dusurur. */}
              <ul className={styles.variantList} role="list" aria-labelledby="varyant-baslik">
                {variantMode.options.map((option) => (
                  <li key={option.key}>
                    <a
                      href={`/urun/${product.slug}?boyut=${encodeURIComponent(option.key)}`}
                      className={styles.variantOption}
                      aria-current={option.key === variantMode.selectedKey ? "true" : undefined}
                      rel="nofollow"
                    >
                      <span>{option.label}</span>
                      <span
                        className={option.inStock ? styles.variantMeta : styles.variantUnavailable}
                      >
                        {option.inStock
                          ? `${formatTRY(option.minPriceKurus)}'den`
                          : "Şu an stokta yok"}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {variantMode ? (
            variantBest ? (
              <div className={styles.primaryOffer}>
                <a
                  href={`/git/${variantBest.offerId}?surface=product_primary`}
                  className={styles.primaryCta}
                >
                  {openAtMerchantLabel(variantBest)}
                </a>
                <p className={styles.primaryMeta}>
                  <span>{offerTotalLabel(variantBest)}</span>
                  {variantBest.inStock ? null : (
                    <span className={styles.outOfStock}>Şu an stokta yok</span>
                  )}
                </p>
                {variantOfferCount > 1 ? (
                  <a href="#magazalar" className={styles.compareLink}>
                    {`${variantOfferCount} mağazanın fiyatını karşılaştır`}
                  </a>
                ) : null}
                <p className={styles.notice}>{HOME_COPY.affiliateNotice}</p>
              </div>
            ) : null
          ) : primaryOffer ? (
            <div className={styles.primaryOffer}>
              {/* attribution: CLAUDE.md kural 8 - dogrudan offer.url'e degil, /git uzerinden. */}
              <a
                href={`/git/${primaryOffer.offerId}?surface=product_primary`}
                className={styles.primaryCta}
              >
                {openAtMerchantLabel(primaryOffer)}
              </a>
              <p className={styles.primaryMeta}>
                <span>{offerTotalLabel(primaryOffer)}</span>
                {primaryOffer.inStock ? null : (
                  <span className={styles.outOfStock}>Şu an stokta yok</span>
                )}
              </p>
              {showOffers ? (
                <a href="#magazalar" className={styles.compareLink}>
                  {`${merchantOffers.length} mağazanın fiyatını karşılaştır`}
                </a>
              ) : null}
              {/* design.md envanteri: affiliate bildirimi çıkış öncesi ve altbilgide. */}
              <p className={styles.notice}>{HOME_COPY.affiliateNotice}</p>
            </div>
          ) : null}

          {/* Varyant modu stok alarmı (0037): ayrı bir seçici yok, ?boyut= seçimi. */}
          {variantMode && selectedOption && !selectedOption.inStock ? (
            <VariantRestockClient
              productId={product.productId}
              sizeNorm={alertSizeNormForVariant(selectedOption.key)}
              label={selectedOption.label}
            />
          ) : null}
          {variantMode?.selectedMissing ? (
            <p className={styles.variantHint}>
              Bu seçenek hiçbir mağazada listelenmediği için stok alarmı kurulamaz.
            </p>
          ) : null}

          {/* 6. Beden seçici + rozet (varyant modunda seçici yukarıda) */}
          {variantMode ? null : (
            <SizeSelectorClient
              productId={product.productId}
              sizes={sizeOptions.map((size) => ({
                sizeNorm: size.sizeNorm,
                label: size.sizeLabel ?? size.sizeNorm,
                available: size.inStock,
              }))}
            />
          )}

          {/* 8. Kaydet / alarm kur */}
          <ProductActionsClient
            productId={product.productId}
            isInStock={merchantOffers.some((offer) => offer.inStock)}
            currentPriceTRY={
              variantMode
                ? Math.floor((variantBest?.priceKurus ?? variantMode.startingPriceKurus) / 100)
                : cheapest
                  ? Math.floor(cheapest.currentPrice / 100)
                  : null
            }
          />

          {/* 9. Diğer renkler */}
          <ColorSwatches
            variants={colorVariants.map((variant, index) => ({
              href: `/urun/${variant.slug}`,
              color: variant.color ?? `Renk ${index + 1}`,
              imageUrl: variant.primaryImageUrl,
            }))}
            label="Diğer renkler"
            labelAs="h2"
          />
        </div>
      </div>

      {/* 7. Mağaza listesi, varyant modu: seçiliyse yalnızca uyumlu satırlar
          ve "En uygun fiyat"; seçim yoksa her satır kendi boyutuyla, rozet yok. */}
      {variantMode &&
      variantRows.length > 0 &&
      (variantOfferCount > 1 || !variantMode.selectedKey) ? (
        <Section
          spacing="compact"
          id="magazalar"
          aria-labelledby="magazalar-baslik"
          className={styles.offers}
        >
          <div className={styles.sectionHeader}>
            <h2 id="magazalar-baslik" className={styles.sectionTitle}>
              {selectedOption ? `Mağaza fiyatları, ${selectedOption.label}` : "Mağaza fiyatları"}
            </h2>
            <p className={styles.sectionMeta}>{`${variantOfferCount} mağaza`}</p>
          </div>
          <MerchantList
            aria-labelledby="magazalar-baslik"
            offers={variantRows.map((row) => {
              const note = unitPriceLabel(row);
              return {
                rowKey: row.rowKey,
                offerId: row.offerId,
                merchantName: row.merchantName,
                ...(variantMode.selectedKey
                  ? {}
                  : { variantLabel: row.variantLabel ?? "Boyutu belirtilmemiş" }),
                ...(note ? { note } : {}),
                totalLabel: formatTRY(row.effectiveTotal),
                shippingLabel: offerShippingLabel(row),
                inStock: row.inStock,
                exitHref: `/git/${row.offerId}?surface=compare`,
                exitLabel: openAtMerchantLabel(row),
              };
            })}
            outOfStockLabel="Şu an stokta yok"
            inStockLabel="Stokta"
            {...(variantBest
              ? { bestOfferLabel: "En uygun fiyat", bestOfferId: variantBest.offerId }
              : {})}
          />
          <p className={styles.disclaimer}>
            {variantMode.selectedKey
              ? `Fiyatlar kargo dahil toplamdır, yalnızca bu seçenek için en uygundan sıralanır. ${HOME_COPY.priceDisclaimer} ${HOME_COPY.affiliateNotice}`
              : `Fiyatlar seçeneğe göre gruplanır; farklı boyutlar birbirinin daha uygun alternatifi değildir. ${HOME_COPY.priceDisclaimer} ${HOME_COPY.affiliateNotice}`}
          </p>
        </Section>
      ) : null}

      {/* 7. Mağaza listesi - tek teklif varsa atlanır (pages.md), noindex D6'nın işi */}
      {!variantMode && showOffers ? (
        <Section
          spacing="compact"
          id="magazalar"
          aria-labelledby="magazalar-baslik"
          className={styles.offers}
        >
          <div className={styles.sectionHeader}>
            <h2 id="magazalar-baslik" className={styles.sectionTitle}>
              Mağaza fiyatları
            </h2>
            <p className={styles.sectionMeta}>{`${merchantOffers.length} mağaza`}</p>
          </div>
          <MerchantList
            aria-labelledby="magazalar-baslik"
            offers={merchantOffers.map((offer) => ({
              offerId: offer.offerId,
              merchantName: offer.merchantName,
              totalLabel: formatTRY(offer.effectiveTotal),
              shippingLabel: offerShippingLabel(offer),
              inStock: offer.inStock,
              exitHref: `/git/${offer.offerId}?surface=compare`,
              exitLabel: openAtMerchantLabel(offer),
            }))}
            outOfStockLabel="Şu an stokta yok"
            inStockLabel="Stokta"
            bestOfferLabel="En uygun fiyat"
            bestOfferId={primaryOffer?.offerId}
          />
          <p className={styles.disclaimer}>
            {`Fiyatlar kargo dahil toplamdır, en uygundan sıralanır. ${HOME_COPY.priceDisclaimer} ${HOME_COPY.affiliateNotice}`}
          </p>
        </Section>
      ) : null}

      {/* 10. Alternatif şeridi */}
      {alternatives.length > 0 ? (
        <Section spacing="compact" aria-labelledby="alternatifler-baslik">
          <div className={styles.sectionHeader}>
            <h2 id="alternatifler-baslik" className={styles.sectionTitle}>
              Daha uygun fiyatlı alternatifler
            </h2>
          </div>
          {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolunu dusurur. */}
          <ul className={styles.altList} role="list" aria-labelledby="alternatifler-baslik">
            {alternatives.map((alt) => (
              <li key={alt.productId}>
                {/* AlternativeProduct'ta offerCount yok (C2 kapsami) - meta satiri cizilmez. */}
                <ProductCard
                  href={`/urun/${alt.slug}`}
                  title={alt.title}
                  imageUrl={alt.primaryImageUrl}
                  minPrice={alt.minPrice}
                  priceFrom={alt.priceFromVariants ?? false}
                  brand={alt.brandName}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 11. Varyant modunda geçmiş yoksa dürüst durum (0037). */}
      {variantMode && !showHistory ? (
        <Section
          spacing="compact"
          aria-labelledby="fiyat-gecmisi-baslik"
          className={styles.history}
        >
          <div className={styles.sectionHeader}>
            <h2 id="fiyat-gecmisi-baslik" className={styles.sectionTitle}>
              Fiyat geçmişi
            </h2>
          </div>
          <p className={styles.historyText}>
            {selectedOption
              ? `${selectedOption.label} için henüz yeterli fiyat geçmişi yok.`
              : "Fiyat geçmişi, bir boyut seçildiğinde yalnızca o boyut için gösterilir."}
          </p>
        </Section>
      ) : null}

      {/* 11. Fiyat grafiği - katlanmış, tıklayınca açılır */}
      {showHistory ? (
        <Section
          spacing="compact"
          aria-labelledby="fiyat-gecmisi-baslik"
          className={styles.history}
        >
          <div className={styles.sectionHeader}>
            <h2 id="fiyat-gecmisi-baslik" className={styles.sectionTitle}>
              Fiyat geçmişi
            </h2>
          </div>
          {historySentence ? <p className={styles.historyText}>{historySentence}</p> : null}
          {historyCoverageNote ? <p className={styles.historyText}>{historyCoverageNote}</p> : null}
          <PriceChart
            points={priceHistory.map((point) => ({
              date: point.date,
              priceKurus: point.minPriceKurus,
            }))}
            // Acik/kapali her iki durumda da dogru kalan notr etiket.
            summaryLabel="Fiyat grafiği"
            chartLabel={historySentence ?? "Fiyat geçmişi"}
          />
        </Section>
      ) : null}
    </div>
  );
}
