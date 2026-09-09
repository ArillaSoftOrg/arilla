import styles from "./PriceChart.module.css";

export interface PriceChartPoint {
  date: string;
  priceKurus: number;
}

export interface PriceChartProps {
  points: readonly PriceChartPoint[];
  /** <details> tetikleyici metni - "Fiyat geçmişi" gibi. */
  summaryLabel: string;
}

const VIEW_WIDTH = 300;
const VIEW_HEIGHT = 80;

function formatAxisDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

/**
 * docs/pages.md "Fiyat grafiği": katlanmış, tıklayınca açılır. docs/design.md
 * "Tek çizgi, eksen etiketi minimum" - kutuphanesiz, tek polyline'lik SVG.
 */
export function PriceChart({ points, summaryLabel }: PriceChartProps) {
  if (points.length < 2) return null;

  const prices = points.map((p) => p.priceKurus);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * VIEW_WIDTH;
    const y = VIEW_HEIGHT - ((point.priceKurus - min) / range) * VIEW_HEIGHT;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = points[0];
  const last = points[points.length - 1];

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>{summaryLabel}</summary>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={summaryLabel}
      >
        <polyline className={styles.line} points={coords.join(" ")} />
      </svg>
      {first && last ? (
        <div className={styles.axisLabels}>
          <span>{formatAxisDate(first.date)}</span>
          <span>{formatAxisDate(last.date)}</span>
        </div>
      ) : null}
    </details>
  );
}
