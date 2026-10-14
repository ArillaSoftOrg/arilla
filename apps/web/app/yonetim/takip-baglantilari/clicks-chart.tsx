import styles from "../admin.module.css";
import { DataTable } from "../admin-ui.tsx";
import { formatCount } from "../format.ts";

const WIDTH = 100;
const HEIGHT = 40;

export interface ClickPoint {
  label: string;
  clicks: number;
}

function points(values: readonly number[], max: number): string {
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = values.length > 1 ? index * step : WIDTH / 2;
      const y = HEIGHT - (max > 0 ? (value / max) * HEIGHT : 0);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * Tıklama eğrisi: sunucuda SVG, istemci betiği yok (trafik grafiğiyle aynı stil).
 * Görsel özet `aria-label`'da; tam değerler açılır tabloda (renk tek başına
 * bilgi taşımaz).
 */
export function ClicksChart({
  series,
  unitLabel,
  formatLabel,
}: {
  series: readonly ClickPoint[];
  unitLabel: string;
  formatLabel: (label: string) => string;
}) {
  const values = series.map((point) => point.clicks);
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const line = values.length > 0 ? points(values, max) : "";
  const area = line ? `0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}` : "";
  const first = series[0];
  const last = series[series.length - 1];
  const label = `${unitLabel} tıklama eğrisi: ${series.length} dönem, toplam ${formatCount(total)}, en yüksek ${formatCount(Math.max(0, ...values))}.`;

  return (
    <figure className={styles.chart}>
      <div className={styles.chartFrame}>
        <svg
          className={styles.chartSvg}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              className={styles.chartGridLine}
              x1={0}
              x2={WIDTH}
              y1={HEIGHT * ratio}
              y2={HEIGHT * ratio}
            />
          ))}
          {area ? <polygon className={styles.chartArea} points={area} /> : null}
          {line ? <polyline className={styles.chartLine} points={line} /> : null}
        </svg>
        <span className={styles.chartMax}>{formatCount(max)}</span>
      </div>
      {first && last ? (
        <div className={styles.chartAxis} aria-hidden="true">
          <span>{formatLabel(first.label)}</span>
          <span>{formatLabel(last.label)}</span>
        </div>
      ) : null}
      <details className={styles.dataDetails}>
        <summary className={styles.dataSummary}>Veri tablosu</summary>
        <DataTable<ClickPoint>
          rows={series}
          rowKey={(point) => point.label}
          columns={[
            { key: "label", header: unitLabel, cell: (point) => formatLabel(point.label) },
            {
              key: "clicks",
              header: "Tıklama",
              numeric: true,
              cell: (point) => formatCount(point.clicks),
            },
          ]}
        />
      </details>
    </figure>
  );
}
