import {
  buildHistoryView,
  defaultRange,
  formatHistoryDate,
  type HistoryObservation,
} from "@arilla/core/price-history-view";
import styles from "./price-history.module.css";
import {
  DIRECTION_GLYPH,
  DIRECTION_WORD,
  formatChangeAmount,
  formatMoney,
} from "./price-history-format.ts";

export interface PriceHistorySummaryProps {
  points: readonly HistoryObservation[];
  currency: string;
  today: string;
  horizonDays: number;
  /** Teklif kaynakta güncel doğrulanamıyorsa: eski fiyat güncelmiş gibi sunulmaz. */
  unverified?: boolean;
}

/**
 * Fiyatın hemen altındaki kompakt fiyat geçmişi özeti (karar 0168). Grafikle aynı
 * seriden ve aynı varsayılan dönemden hesaplanır; "değişim" iki GÖZLEM arasındadır,
 * fiyatın değiştiği tarih bilinmez. Sunucu bileşeni: etkileşim yok, yalnızca bağlantı.
 */
export function PriceHistorySummary({
  points,
  currency,
  today,
  horizonDays,
  unverified = false,
}: PriceHistorySummaryProps) {
  if (points.length === 0) return null;
  const view = buildHistoryView(points, defaultRange(points, today, horizonDays), today);
  const { change } = view;
  const first = view.points[0];
  const last = view.points[view.points.length - 1];
  const stale = unverified || view.stale;

  return (
    <div className={styles.summaryBox}>
      {change && first && last ? (
        <p className={styles.summaryLine}>
          <span
            className={`${styles.change} ${styles[change.direction]} tabular-nums`}
            data-direction={change.direction}
          >
            <span aria-hidden="true">{DIRECTION_GLYPH[change.direction]}</span>{" "}
            {change.direction === "flat"
              ? `Fiyat değişmedi (${formatMoney(last.priceMinor, currency)})`
              : `${formatChangeAmount(change, currency)} ${DIRECTION_WORD[change.direction]}`}
          </span>
          <span className={styles.summaryMeta}>
            {`${formatHistoryDate(first.date)} – ${formatHistoryDate(last.date)} gözlemleri`}
          </span>
        </p>
      ) : (
        <p className={styles.summaryLine}>
          <span className={styles.summaryMeta}>
            {`Tek fiyat gözlemi var (${formatHistoryDate(last?.date ?? today)}); değişim henüz görülemiyor.`}
          </span>
        </p>
      )}
      {stale ? (
        <p className={styles.summaryWarn}>Son gözlem güncel değil; fiyat değişmiş olabilir.</p>
      ) : null}
      <a className={styles.historyLink} href="#fiyat-gecmisi">
        Fiyat geçmişini gör
      </a>
    </div>
  );
}
