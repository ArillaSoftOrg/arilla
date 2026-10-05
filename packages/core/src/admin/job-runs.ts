/**
 * `job_run` okuma modeli (karar 0052/0055): işlerin son koşusu ve koşu
 * geçmişi. Yazanlar: Python boru hattı işleri (`services/ingest/db/job_run.py`)
 * ve cron uçları (`packages/core/src/ops/job-run.ts`). Salt okunur; yeniden
 * dene / şimdi çalıştır YOK.
 */
import type { Database, JobRunStatus, JobRunTrigger } from "@arilla/db";
import { sql } from "drizzle-orm";
import { clampPageSize, isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { redactText } from "./redact.ts";

/** Bu süreden uzun `running` kalan koşu takılı sayılır (süreç ölmüş, kapanmamış). */
export const STUCK_JOB_AFTER_MS = 2 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;

export interface KnownJob {
  label: string;
  /** Elle çalıştırma komutu ya da tetikleyen. */
  how: string;
  kind: "pipeline" | "cron";
  /** Zamanlanmış iş: son koşu bundan eskiyse gecikmiş. Elle çalışan işte `null`. */
  overdueAfterMs: number | null;
}

/** Bilinen işler. Tabloda başka bir ad görülürse o da listelenir (etiketsiz). */
export const KNOWN_JOBS: Readonly<Record<string, KnownJob>> = {
  collect: {
    label: "Veri toplama (tek mağaza)",
    how: "python -m collect --merchant <slug>",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  collect_bootstrap: {
    label: "Veri toplama (bootstrap)",
    how: "python -m collect.bootstrap",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  resolve: {
    label: "Eşleştirme",
    how: "python -m resolve",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  enrich: {
    label: "Zenginleştirme (vektör)",
    how: "python -m enrich",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  similarity: {
    label: "Benzerlik + fiyat özeti",
    how: "python -m similarity",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  similarity_edges: {
    label: "Benzerlik kenarları",
    how: "python -m similarity --edges",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  similarity_prices: {
    label: "Fiyat özeti",
    how: "python -m similarity --prices",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  link_refresh: {
    label: "Link yenileme",
    how: "python -m collect.link --refresh",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Karar 0059: korumalı uç, zamanlanmamış. `cron` değil: zamanlayıcı yokken
  // "kayıt yok" bulgusu yanlış alarm olurdu.
  query_interpretation: {
    label: "Sorgu yorumlama (model, çevrimdışı)",
    how: "/api/cron/interpret-queries (elle; GEMINI_API_KEY yoksa atlanır)",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  discovery_slots: {
    label: "Keşfet slotları",
    how: "Vercel cron (günlük)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  cleanup_auth: {
    label: "Günlük temizlik (giriş, arama hakkı, saklama)",
    how: "Vercel cron (günlük)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  trigger_alerts: {
    label: "Fiyat alarmları",
    how: "GitHub Actions (15 dk)",
    kind: "cron",
    overdueAfterMs: 2 * HOUR,
  },
  marketing_campaigns: {
    label: "Pazarlama e-postası teslimi",
    how: "GitHub Actions (15 dk)",
    kind: "cron",
    overdueAfterMs: 2 * HOUR,
  },
};

export function jobLabel(job: string): string {
  return KNOWN_JOBS[job]?.label ?? job;
}

export interface JobRunRow {
  id: number;
  job: string;
  trigger: JobRunTrigger;
  status: JobRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  detail: Record<string, unknown>;
  errorSummary: string | null;
}

export interface JobLastRun {
  job: string;
  lastRun: JobRunRow | null;
  /** Son `success`/`partial` koşunun bitişi. */
  lastGoodAt: Date | null;
  /** Son iyi koşudan sonraki başarısız koşu sayısı (en fazla 50 sayılır). */
  failuresSinceGood: number;
}

export interface JobRunSummary {
  jobs: JobLastRun[];
  /** `STUCK_JOB_AFTER_MS`'ten uzun `running` kalan koşular (tüm işler). */
  stuck: { id: number; job: string; startedAt: Date }[];
}

type RunSqlRow = {
  id: string;
  job: string;
  trigger: JobRunTrigger;
  status: JobRunStatus;
  started_at: string;
  finished_at: string | null;
  detail: Record<string, unknown> | null;
  error_summary: string | null;
};

function toRun(row: RunSqlRow): JobRunRow {
  const startedAt = new Date(row.started_at);
  const finishedAt = row.finished_at ? new Date(row.finished_at) : null;
  return {
    id: Number(row.id),
    job: row.job,
    trigger: row.trigger,
    status: row.status,
    startedAt,
    finishedAt,
    durationMs: finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
    detail: row.detail && typeof row.detail === "object" ? row.detail : {},
    // Yazarken kırpıldı; gösterimde ikinci kez (eski/elle yazılmış satır için).
    errorSummary: redactText(row.error_summary, 500),
  };
}

/**
 * İş başına son koşu + son iyi koşu (`job_run_job_idx` ile iş başına LATERAL
 * tek satır). Çağıran yetkiyi denetler (`getOperationsOverview`,
 * `getPipelineEvidence`).
 */
export async function readJobRunSummary(db: Database): Promise<JobRunSummary> {
  const stuckSeconds = Math.round(STUCK_JOB_AFTER_MS / 1000);
  const known = Object.keys(KNOWN_JOBS);
  return readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<
      RunSqlRow & { name: string; last_good_at: string | null; failures: string }
    >(sql`
      SELECT j.name, lr.id, lr.job, lr.trigger, lr.status, lr.started_at, lr.finished_at,
             lr.detail, left(lr.error_summary, 500) AS error_summary,
             lg.finished_at AS last_good_at,
             (SELECT count(*) FROM (
                SELECT 1 FROM job_run f
                 WHERE f.job = j.name AND f.status = 'failed'
                   AND f.started_at > coalesce(lg.started_at, '-infinity'::timestamptz)
                 LIMIT 50) x) AS failures
        FROM (
          SELECT unnest(ARRAY[${sql.join(
            known.map((job) => sql`${job}`),
            sql`, `,
          )}]::text[]) AS name
          UNION
          SELECT DISTINCT job FROM job_run WHERE started_at > now() - interval '30 days'
        ) j
        LEFT JOIN LATERAL (
          SELECT r.* FROM job_run r WHERE r.job = j.name ORDER BY r.started_at DESC LIMIT 1
        ) lr ON true
        LEFT JOIN LATERAL (
          SELECT r.started_at, r.finished_at FROM job_run r
           WHERE r.job = j.name AND r.status IN ('success','partial')
           ORDER BY r.started_at DESC LIMIT 1
        ) lg ON true
       ORDER BY j.name
       LIMIT 60
    `);
    const stuck = await tx.execute<{ id: string; job: string; started_at: string }>(sql`
      SELECT id, job, started_at FROM job_run
       WHERE status = 'running' AND started_at < now() - make_interval(secs => ${stuckSeconds})
       ORDER BY started_at DESC
       LIMIT 20
    `);
    const order = (job: string) => {
      const i = known.indexOf(job);
      return i === -1 ? known.length : i;
    };
    return {
      jobs: result.rows
        .map((row) => ({
          job: row.name,
          lastRun: row.id ? toRun(row) : null,
          lastGoodAt: row.last_good_at ? new Date(row.last_good_at) : null,
          failuresSinceGood: Number(row.failures ?? 0),
        }))
        .sort((a, b) => order(a.job) - order(b.job) || a.job.localeCompare(b.job)),
      stuck: stuck.rows.map((row) => ({
        id: Number(row.id),
        job: row.job,
        startedAt: new Date(row.started_at),
      })),
    };
  });
}

export const JOB_RUN_STATUSES: readonly JobRunStatus[] = [
  "running",
  "success",
  "partial",
  "failed",
];

export interface JobRunFilter {
  job?: string;
  status?: JobRunStatus;
  beforeId?: number;
  pageSize?: number;
}

/** Koşu geçmişi (`/yonetim/islemler/isler`), imleçli ve sınırlı. Yalnızca yönetici. */
export async function listJobRuns(
  db: Database,
  actor: AdminActor,
  filter: JobRunFilter = {},
): Promise<{ rows: JobRunRow[]; nextBeforeId: number | null }> {
  assertCapability(actor, "operations.read");
  const pageSize = clampPageSize(filter.pageSize);
  const conditions = [sql`true`];
  if (filter.job && /^[a-z][a-z0-9_]{1,39}$/.test(filter.job)) {
    conditions.push(sql`job = ${filter.job}`);
  }
  if (filter.status && (JOB_RUN_STATUSES as readonly string[]).includes(filter.status)) {
    conditions.push(sql`status = ${filter.status}`);
  }
  if (isPositiveId(filter.beforeId)) conditions.push(sql`id < ${filter.beforeId}`);
  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<RunSqlRow>(sql`
      SELECT id, job, trigger, status, started_at, finished_at, detail,
             left(error_summary, 500) AS error_summary
        FROM job_run
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY id DESC
       LIMIT ${pageSize + 1}
    `);
    return result.rows;
  });
  const page = rows.slice(0, pageSize).map(toRun);
  const last = page[page.length - 1];
  return { rows: page, nextBeforeId: rows.length > pageSize && last ? last.id : null };
}
