/**
 * `/yonetim/ai/kalite` (karar 0097): AI degerlendirme ve kalite paneli.
 *
 * Yalnizca KAYDEDILMIS sonuclari okur (`ai_eval_*`, `dataset_snapshot`,
 * `ai_error_event`, `api_usage`). Gemini/Jina cagirmaz, yazmaz, hesaplamak icin
 * model calistirmaz. Ham sorgu, sohbet metni, vaka anahtari ve kullanici
 * kimligi secilmez: yalnizca toplamlar ve surum etiketleri.
 *
 * Dürüstlük kuralları:
 * - Kayitli metrik yoksa `null` doner (panel "Henuz veri yok" yazar); 0 uydurulmaz.
 * - Regresyon yalniz AYNI bilesen ve AYNI veri seti icerigi (snapshot) olan iki
 *   kosu arasinda hesaplanir; farkli veri setinde "karsilastirilamaz" denir.
 */
import type { Database, EvalComponent } from "@arilla/db";
import { sql } from "drizzle-orm";
import { COMPONENT_METRICS, COMPONENT_ORDER, type MetricSpec } from "../eval/metric-keys.ts";
import { compareRuns } from "../eval/metrics.ts";
import { type AnalyticsWindow, parseAnalyticsWindow } from "./ai-operations.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

type Num = number | string | null;
const n = (v: Num | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const nullable = (v: Num | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Kayit satirinin panelin ihtiyac duydugu kesiti. */
export interface QualityRun {
  id: number;
  component: EvalComponent;
  createdAt: Date;
  algorithmVersion: string;
  modelVersion: string | null;
  live: boolean;
  trigger: string;
  snapshotId: number;
  datasetVersion: string;
  verifiedCount: number;
  metrics: Record<string, number>;
  regressedFlag: boolean | null;
  apiCalls: number;
  costMicros: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export type MetricStatus = "ok" | "regressed" | "improved" | "same" | "no_baseline" | "no_data";

export interface MetricView {
  key: string;
  label: string;
  direction: MetricSpec["direction"];
  /** Son kosuda kayitli deger; yoksa `null` (0 DEGIL). */
  value: number | null;
  previous: number | null;
  delta: number | null;
  status: MetricStatus;
}

export type Comparability = "comparable" | "no_previous" | "dataset_changed";

export interface ComponentQuality {
  component: EvalComponent;
  latest: QualityRun | null;
  previous: QualityRun | null;
  comparability: Comparability;
  metrics: MetricView[];
  /** Karsilastirilabilir kosuda en az bir metrik kotulesti. */
  regressed: boolean;
  /** Son kosudaki basarisiz vaka sinifi dagilimi (vaka anahtari/metin yok). */
  failureClasses: { failureClass: string; count: number }[];
}

/** Bu toleransin altindaki oynama regresyon sayilmaz. */
export const QUALITY_TOLERANCE = 0.005;

/** Saf: son/onceki kosudan metrik gorunumleri ve regresyon. */
export function buildComponentQuality(
  component: EvalComponent,
  latest: QualityRun | null,
  previous: QualityRun | null,
  failureClasses: ComponentQuality["failureClasses"] = [],
): ComponentQuality {
  const specs = COMPONENT_METRICS[component];
  const comparability: Comparability =
    !latest || !previous
      ? "no_previous"
      : latest.snapshotId === previous.snapshotId
        ? "comparable"
        : "dataset_changed";

  const directions = Object.fromEntries(specs.map((s) => [s.key, s.direction]));
  const changes =
    comparability === "comparable" && latest && previous
      ? new Map(
          compareRuns(previous.metrics, latest.metrics, directions, QUALITY_TOLERANCE).map((c) => [
            c.metric,
            c,
          ]),
        )
      : new Map();

  const metrics: MetricView[] = specs.map((spec) => {
    const value = finite(latest?.metrics[spec.key]);
    const before = finite(previous?.metrics[spec.key]);
    const change = changes.get(spec.key);
    let status: MetricStatus;
    if (value === null) status = "no_data";
    else if (!change) status = "no_baseline";
    else if (change.regressed) status = "regressed";
    else if (Math.abs(change.delta) <= QUALITY_TOLERANCE) status = "same";
    else status = "improved";
    return {
      key: spec.key,
      label: spec.label,
      direction: spec.direction,
      value,
      previous: before,
      delta: change ? change.delta : null,
      status,
    };
  });

  return {
    component,
    latest,
    previous,
    comparability,
    metrics,
    regressed: metrics.some((m) => m.status === "regressed"),
    failureClasses,
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ErrorDistributionRow {
  provider: string;
  errorClass: string;
  count: number;
  p95LatencyMs: number | null;
}

export interface VersionRow {
  /** `api_usage.model_version` ya da kosu surumu. */
  label: string;
  calls: number;
}

export interface AiQualityOverview {
  generatedAt: Date;
  days: AnalyticsWindow;
  components: ComponentQuality[];
  history: QualityRun[];
  errors: { total: number; byKind: ErrorDistributionRow[] };
  /** Pencerede api_usage'ta gorulen model surumleri (cagri sayisiyla). */
  modelVersionsInUse: VersionRow[];
  evalCost: { runs: number; liveRuns: number; apiCalls: number; costMicros: number };
}

type RunRaw = {
  id: Num;
  component: EvalComponent;
  created_at: Date;
  algorithm_version: string;
  model_version: string | null;
  live: boolean;
  trigger: string;
  snapshot_id: Num;
  dataset_version: string;
  verified_count: Num;
  metrics: Record<string, number>;
  regressed: boolean | null;
  api_calls: Num;
  cost_micros: Num;
  latency_p50_ms: Num;
  latency_p95_ms: Num;
};

function toRun(row: RunRaw): QualityRun {
  return {
    id: n(row.id),
    component: row.component,
    createdAt: new Date(row.created_at),
    algorithmVersion: row.algorithm_version,
    modelVersion: row.model_version,
    live: row.live,
    trigger: row.trigger,
    snapshotId: n(row.snapshot_id),
    datasetVersion: row.dataset_version,
    verifiedCount: n(row.verified_count),
    metrics: row.metrics ?? {},
    regressedFlag: row.regressed,
    apiCalls: n(row.api_calls),
    costMicros: n(row.cost_micros),
    latencyP50Ms: nullable(row.latency_p50_ms),
    latencyP95Ms: nullable(row.latency_p95_ms),
  };
}

const RUN_COLUMNS = sql`
  r.id, r.component, r.created_at, r.algorithm_version, r.model_version, r.live, r.trigger,
  r.snapshot_id, s.version AS dataset_version, s.verified_count, r.metrics, r.regressed,
  r.api_calls, r.cost_micros, r.latency_p50_ms, r.latency_p95_ms`;

export async function getAiQualityOverview(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown } = {},
): Promise<AiQualityOverview> {
  assertCapability(actor, "ai.read");
  const days = parseAnalyticsWindow(options.days, 30);
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);

  return readOnly(db, 8000, async (tx) => {
    // Bilesen basina son iki kosu (`ai_eval_run_component_idx`).
    const lastTwo = await tx.execute<RunRaw>(sql`
      SELECT * FROM (
        SELECT ${RUN_COLUMNS},
               row_number() OVER (PARTITION BY r.component ORDER BY r.id DESC) AS rn
          FROM ai_eval_run r JOIN dataset_snapshot s ON s.id = r.snapshot_id
      ) t WHERE rn <= 2 ORDER BY component, rn
    `);
    const history = await tx.execute<RunRaw>(sql`
      SELECT ${RUN_COLUMNS}
        FROM ai_eval_run r JOIN dataset_snapshot s ON s.id = r.snapshot_id
       WHERE r.created_at >= ${since}
       ORDER BY r.id DESC
       LIMIT 50
    `);

    const byComponent = new Map<EvalComponent, QualityRun[]>();
    for (const raw of lastTwo.rows) {
      const list = byComponent.get(raw.component) ?? [];
      list.push(toRun(raw));
      byComponent.set(raw.component, list);
    }

    const latestIds = [...byComponent.values()].map((runs) => (runs[0] as QualityRun).id);
    const failures =
      latestIds.length === 0
        ? { rows: [] as { run_id: Num; failure_class: string; count: Num }[] }
        : await tx.execute<{ run_id: Num; failure_class: string; count: Num }>(sql`
            SELECT run_id, failure_class, count(*) AS count
              FROM ai_eval_case
             WHERE outcome IN ('fail','error') AND failure_class IS NOT NULL
               AND run_id IN (${sql.join(
                 latestIds.map((id) => sql`${id}`),
                 sql`, `,
               )})
             GROUP BY 1, 2
             ORDER BY 3 DESC
             LIMIT 100
          `);

    const components = COMPONENT_ORDER.map((component) => {
      const [latest = null, previous = null] = byComponent.get(component) ?? [];
      const classes = latest
        ? failures.rows
            .filter((f) => n(f.run_id) === latest.id)
            .map((f) => ({ failureClass: f.failure_class, count: n(f.count) }))
        : [];
      return buildComponentQuality(component, latest, previous, classes);
    });

    const errors = await tx.execute<{
      provider: string;
      error_class: string;
      count: Num;
      p95: Num;
    }>(sql`
      SELECT provider, error_class, count(*) AS count,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
        FROM ai_error_event
       WHERE occurred_at >= ${since}
       GROUP BY 1, 2
       ORDER BY 3 DESC
       LIMIT 50
    `);
    const versions = await tx.execute<{ label: string; calls: Num }>(sql`
      SELECT COALESCE(model_version, '(modelsiz / önbellek)') AS label, count(*) AS calls
        FROM api_usage
       WHERE created_at >= ${since}
       GROUP BY 1
       ORDER BY 2 DESC
       LIMIT 20
    `);
    const cost = await tx.execute<{ runs: Num; live_runs: Num; calls: Num; micros: Num }>(sql`
      SELECT count(*) AS runs, count(*) FILTER (WHERE live) AS live_runs,
             COALESCE(sum(api_calls), 0) AS calls, COALESCE(sum(cost_micros), 0) AS micros
        FROM ai_eval_run
       WHERE created_at >= ${since}
    `);

    const byKind = errors.rows.map((row) => ({
      provider: row.provider,
      errorClass: row.error_class,
      count: n(row.count),
      p95LatencyMs: nullable(row.p95),
    }));
    const costRow = cost.rows[0];
    return {
      generatedAt: now,
      days,
      components,
      history: history.rows.map(toRun),
      errors: { total: byKind.reduce((sum, r) => sum + r.count, 0), byKind },
      modelVersionsInUse: versions.rows.map((row) => ({ label: row.label, calls: n(row.calls) })),
      evalCost: {
        runs: n(costRow?.runs),
        liveRuns: n(costRow?.live_runs),
        apiCalls: n(costRow?.calls),
        costMicros: n(costRow?.micros),
      },
    };
  });
}

export { COMPONENT_LABELS, COMPONENT_ORDER } from "../eval/metric-keys.ts";
