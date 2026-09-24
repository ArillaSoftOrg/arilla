import { formatTRY } from "./format.ts";
import styles from "./PriceChart.module.css";

export interface PriceChartPoint {
  date: string;
  priceKurus: number;
}

export interface PriceChartProps {
  points: readonly PriceChartPoint[];
  /** <details> tetikleyici metni - "Fiyat geçmişi" gibi. */
  summaryLabel: string;
  /**
   * Grafigin erisilebilir adi - verilmezse `summaryLabel`. Seriyi ozetleyen
   * bir cumle olmali ("Son 90 günde 1.199 TL ile 1.499 TL arasında").
   */
  chartLabel?: string;
  /** Verilirse <details> acik baslar. Varsayilan kapali (docs/pages.md). */
  defaultOpen?: boolean;
}

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 160;
/** Cizginin ust/alt kenarda kirpilmamasi icin dikey pay (viewBox birimi). */
const VIEW_PAD = 8;

function formatAxisDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

/**
 * docs/pages.md "Fiyat grafiği": katlanmış, tıklayınca açılır. docs/design.md
 * "Tek çizgi, eksen etiketi minimum" - kutuphanesiz, tek polyline'lik SVG.
 * Eksen etiketleri SVG disinda HTML'dir: `preserveAspectRatio="none"` ile
 * esnetilen SVG icindeki metin bozulurdu.
 */
export function PriceChart({ points, summaryLabel, chartLabel, defaultOpen }: PriceChartProps) {
  if (points.length < 2) return null;

  const prices = points.map((p) => p.priceKurus);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const drawable = VIEW_HEIGHT - VIEW_PAD * 2;

  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * VIEW_WIDTH;
    const y =
      max === min
        ? VIEW_HEIGHT / 2
        : VIEW_PAD + drawable - ((point.priceKurus - min) / range) * drawable;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = points[0];
  const last = points[points.length - 1];

  return (
    <details className={styles.details} open={defaultOpen}>
      <summary className={styles.summary}>
        <span>{summaryLabel}</span>
        <span className={styles.chevron} aria-hidden="true" />
      </summary>
      <figure className={styles.figure}>
        <div className={styles.plot}>
          <svg
            className={styles.chart}
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={chartLabel ?? summaryLabel}
          >
            <line className={styles.grid} x1="0" x2={VIEW_WIDTH} y1={VIEW_PAD} y2={VIEW_PAD} />
            <line
              className={styles.grid}
              x1="0"
              x2={VIEW_WIDTH}
              y1={VIEW_HEIGHT - VIEW_PAD}
              y2={VIEW_HEIGHT - VIEW_PAD}
            />
            <polyline className={styles.line} points={coords.join(" ")} />
          </svg>
          <div className={`${styles.yLabels} tabular-nums`} aria-hidden="true">
            <span>{formatTRY(max)}</span>
            <span>{formatTRY(min)}</span>
          </div>
        </div>
        {first && last ? (
          <div className={`${styles.xLabels} tabular-nums`} aria-hidden="true">
            <span>{formatAxisDate(first.date)}</span>
            <span>{formatAxisDate(last.date)}</span>
          </div>
        ) : null}
      </figure>
    </details>
  );
}
