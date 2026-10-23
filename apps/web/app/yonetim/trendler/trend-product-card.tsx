import Link from "next/link";
import styles from "../admin.module.css";
import { StatusBadge } from "../admin-ui.tsx";
import { formatKurus, trendProductWarningLabel } from "../format.ts";
import { ProductThumb } from "../katalog/urunler/product-thumb-client.tsx";
import type { TrendProductCardView } from "./card-view.ts";

/**
 * Ürünü gösterilemez yapan uyarılar. Core `BLOCKING_WARNINGS` ile aynı küme; istemci paketine
 * sunucu modülü taşınmasın diye burada tekrarlanır, eşitliği `trend-admin.test.ts` sınar.
 */
export const BLOCKING_WARNING_KEYS: ReadonlySet<string> = new Set([
  "not_published",
  "missing_image",
  "no_try_price",
  "out_of_stock",
]);

/**
 * Koleksiyon ürün kartı (karar 0149): görsel, marka, TL fiyat, stok, kaynak, yayın durumu ve
 * uyarılar. Uyarılar veri tazeliği/tutarlılığıdır; orijinallik iddiası değildir.
 */
export function TrendProductCardBody({ card }: { card: TrendProductCardView }) {
  const price =
    card.minPrice && card.maxPrice && card.maxPrice !== card.minPrice
      ? `${formatKurus(card.minPrice)} – ${formatKurus(card.maxPrice)}`
      : formatKurus(card.minPrice);
  return (
    <span className={styles.row}>
      <ProductThumb
        src={card.imageUrl}
        size={48}
        className={styles.thumb}
        emptyClassName={styles.meta}
      />
      <span className={styles.list}>
        <Link href={`/yonetim/katalog/urunler/${card.id}`}>{card.title}</Link>
        <span className={styles.meta}>
          {[
            card.brandName ?? "Markasız",
            price,
            `${card.inStockCount}/${card.offerCount} mağazada stokta`,
            card.sourceMerchant ? `kaynak: ${card.sourceMerchant.name}` : "kaynak: eşleştirme",
            `#${card.id}`,
          ].join(" · ")}
        </span>
        <span className={styles.row}>
          {card.showable ? (
            <StatusBadge tone="success">Gösterilebilir</StatusBadge>
          ) : (
            <StatusBadge tone="critical">Gösterilemez</StatusBadge>
          )}
          {card.publicationState !== "published" ? (
            <StatusBadge tone="neutral">{`Durum: ${card.publicationState}`}</StatusBadge>
          ) : null}
          {card.warnings.map((warning) => (
            <StatusBadge
              key={warning}
              tone={BLOCKING_WARNING_KEYS.has(warning) ? "critical" : "warning"}
            >
              {trendProductWarningLabel(warning)}
            </StatusBadge>
          ))}
        </span>
      </span>
    </span>
  );
}
