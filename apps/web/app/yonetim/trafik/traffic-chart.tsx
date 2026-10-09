import type { TrafficSeriesPoint } from "@arilla/core";
import styles from "../admin.module.css";
import { DataTable } from "../admin-ui.tsx";
import { formatCount, trafficBucketLabel } from "../format.ts";

export type TrafficMeasure = "users" | "sessions" | "pageViews";

export const MEASURE_LABELS: Record<TrafficMeasure, string> = {
  users: "Kullanıcı",
  sessions: "Oturum",
  pageViews: "Sayfa görüntüleme",
};

const WIDTH = 100;
const HEIGHT = 40;

function points(values: readonly number[], max: number): string {
  if (values.length === 0) return "";
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
 * Trafik eğrisi (karar 0087): sunucuda SVG, istemci betiği ve bağımlılık
 * yok. Seçili dönem alan + çizgi, önceki dönem kesikli. Görsel özet
 * `aria-label`'da; tam değerler aşağıdaki açılır tabloda (renk ya da
 * çizgi tek başına bilgi taşımaz).
 */
export function TrafficChart({
  series,
  measure,
  granularity,
}: {
  series: readonly TrafficSeriesPoint[];
  measure: TrafficMeasure;
  granularity: string;
}) {
  const current = series.map((point) => point.current[measure]);
  const previous = series.map((point) => point.previous?.[measure] ?? null);
  const hasPrevious = previous.some((value) => value !== null);
  const max = Math.max(1, ...current, ...previous.map((value) => value ?? 0));
  const line = points(current, max);
  const area = line ? `0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}` : "";
  const previousLine = hasPrevious
    ? points(
        previous.map((value) => value ?? 0),
        max,
      )
    : "";
  const total = current.reduce((sum, value) => sum + value, 0);
  const first = series[0];
  const last = series[series.length - 1];
  const middle = series[Math.floor(series.length / 2)];
  const label = `${MEASURE_LABELS[measure]} eğrisi: ${series.length} dönem, toplam ${formatCount(total)}, en yüksek ${formatCount(Math.max(0, ...current))}.`;

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
          {previousLine ? (
            <polyline className={styles.chartPrevious} points={previousLine} />
          ) : null}
          {line ? <polyline className={styles.chartLine} points={line} /> : null}
        </svg>
        <span className={styles.chartMax}>{formatCount(max)}</span>
      </div>
      {first && last ? (
        <div className={styles.chartAxis} aria-hidden="true">
          <span>{trafficBucketLabel(first.key, granularity)}</span>
          {middle && series.length > 2 ? (
            <span>{trafficBucketLabel(middle.key, granularity)}</span>
          ) : null}
          <span>{trafficBucketLabel(last.key, granularity)}</span>
        </div>
      ) : null}
      <figcaption className={styles.chartLegend}>
        <span className={styles.legendItem}>
          <span className={styles.legendCurrent} aria-hidden="true" />
          Seçili dönem
        </span>
        {hasPrevious ? (
          <span className={styles.legendItem}>
            <span className={styles.legendPrevious} aria-hidden="true" />
            Önceki dönem (aynı uzunluk)
          </span>
        ) : null}
      </figcaption>
      <details className={styles.dataDetails}>
        <summary className={styles.dataSummary}>Veri tablosu</summary>
        <DataTable<TrafficSeriesPoint>
          rows={series}
          rowKey={(point) => point.key}
          columns={[
            {
              key: "bucket",
              header: "Dönem",
              cell: (point) => trafficBucketLabel(point.key, granularity),
            },
            {
              key: "current",
              header: MEASURE_LABELS[measure],
              numeric: true,
              cell: (point) => formatCount(point.current[measure]),
            },
            {
              key: "previous",
              header: "Önceki dönem",
              numeric: true,
              cell: (point) => (point.previous ? formatCount(point.previous[measure]) : "—"),
            },
          ]}
        />
      </details>
    </figure>
  );
}

/** Dağılım hücresi: değer + oranın çubuğu (en büyük satıra göre). */
export function BarValue({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className={styles.barCell}>
      <span>{formatCount(value)}</span>
      <span className={styles.barTrack} aria-hidden="true">
        <span className={styles.barFill} style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}
