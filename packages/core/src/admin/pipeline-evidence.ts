/**
 * Veri boru hattının son kanıtı (docs/decisions/0051, 0055). Aşamanın
 * `job_run` kaydı varsa (Python işleri 0055'ten beri yazar) "son çalıştı"
 * oradan okunur: son başarılı/kısmi koşunun bitişi; son koşu başarısızsa ya
 * da takılıysa aşama uyarıdır. Kayıt yoksa (eski kurulum, iş hiç bu sürümle
 * çalışmadı) ÜRETTİĞİ verinin en yeni zaman damgasına düşülür ve öyle
 * etiketlenir: "son kanıt". Aşamalar (`services/ingest`, hepsi elle):
 *
 * - collect    → `ingest_run`                (python -m collect.bootstrap)
 * - resolve    → `match_candidate.created_at` (python -m resolve)
 *                Yalnızca YENİ aday satırı kanıttır; mevcut çifti yeniden
 *                skorlayan koşu iz bırakmaz.
 * - prices     → `product_price_stats.computed_at` (python -m similarity --prices)
 * - enrich     → `embedding.created_at`, ürün/teklif (python -m enrich)
 * - edges      → `similarity_edge.computed_at` (python -m similarity --edges)
 * - link       → `link_resolution_request` (link çözümleme işçisi)
 *
 * "Geride olabilir": aşamanın son kanıtı, beslendiği aşamanınkinden eski.
 * Kesin değildir (yeni veri yoksa aşama iz bırakmaz), o yüzden uyarı değil
 * bilgi düzeyindedir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { type JobLastRun, readJobRunSummary, STUCK_JOB_AFTER_MS } from "./job-runs.ts";
import { STALE_FEED_AFTER_MS, STUCK_RUN_AFTER_MS } from "./merchant-attention.ts";

/** Link işi bu süreden uzun `processing`/`queued` kalırsa takılmış sayılır. */
export const LINK_STUCK_AFTER_MS = 10 * 60 * 1000;

export const PIPELINE_STAGES = ["collect", "resolve", "prices", "enrich", "edges", "link"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Aşama → beslendiği (önceki) aşamalar. */
const UPSTREAM: Record<PipelineStage, PipelineStage[]> = {
  collect: [],
  resolve: ["collect"],
  prices: ["resolve"],
  enrich: ["collect"],
  edges: ["enrich"],
  link: [],
};

/**
 * Aşama → onu yürüten `job_run.job` adları. Toplama `ingest_run`'dan (zaten
 * koşu kaydı), link çözümleme işçiden okunur; ikisi burada yok.
 */
export const STAGE_JOBS: Partial<Record<PipelineStage, readonly string[]>> = {
  resolve: ["resolve"],
  prices: ["similarity", "similarity_prices"],
  enrich: ["enrich"],
  edges: ["similarity", "similarity_edges"],
};

/** Aşamanın iş koşusu kanıtı (`job_run`). */
export interface StageRunEvidence {
  /** Son başarılı/kısmi koşunun bitişi. */
  lastGoodAt: Date | null;
  /** En yeni koşu. */
  lastStatus: "running" | "success" | "partial" | "failed";
  lastStartedAt: Date;
}

export interface PipelineRawEvidence {
  collect: { lastStartedAt: Date | null; lastGoodAt: Date | null; stuckRuns: number } | null;
  resolve: { lastAt: Date | null } | null;
  prices: { lastAt: Date | null } | null;
  enrich: { lastAt: Date | null } | null;
  edges: { lastAt: Date | null } | null;
  link: {
    lastFinishedAt: Date | null;
    stuckProcessing: number;
    oldestQueuedAt: Date | null;
  } | null;
  /**
   * `job_run` kanıtı, aşama başına (karar 0055). Yoksa ya da okunamadıysa
   * aşama veri zamanına düşer.
   */
  runs?: Partial<Record<PipelineStage, StageRunEvidence | null>>;
}

/** Aşamanın işleri arasından en yeni koşu ve en yeni iyi koşu. Saf. */
export function stageRunEvidence(
  jobs: readonly JobLastRun[],
): Partial<Record<PipelineStage, StageRunEvidence | null>> {
  const out: Partial<Record<PipelineStage, StageRunEvidence | null>> = {};
  for (const [stage, names] of Object.entries(STAGE_JOBS) as [PipelineStage, string[]][]) {
    let latest: JobLastRun["lastRun"] = null;
    let lastGoodAt: Date | null = null;
    for (const job of jobs) {
      if (!names.includes(job.job)) continue;
      if (job.lastRun && (!latest || job.lastRun.startedAt > latest.startedAt)) {
        latest = job.lastRun;
      }
      if (job.lastGoodAt && (!lastGoodAt || job.lastGoodAt > lastGoodAt)) {
        lastGoodAt = job.lastGoodAt;
      }
    }
    out[stage] = latest
      ? { lastGoodAt, lastStatus: latest.status, lastStartedAt: latest.startedAt }
      : null;
  }
  return out;
}

export type PipelineStageState =
  /** Kanıt okunamadı (zaman aşımı/hata). */
  | "unknown"
  /** Hiç kanıt yok. */
  | "none"
  /** Takılı iş ya da eşik aşımı: müdahale gerekir. */
  | "warning"
  /** Beslendiği aşamadan eski: çalıştırılması gerekebilir. */
  | "behind"
  | "ok";

export interface PipelineStageView {
  stage: PipelineStage;
  state: PipelineStageState;
  /** Aşamanın en yeni kanıtı (collect için son başarılı/kısmi koşu). */
  lastAt: Date | null;
  /**
   * Kısa, sabit açıklama kodu: `stuck_runs`, `stale_feed`, `link_stuck`,
   * `link_queue_old`, `job_failed`, `job_stuck`.
   */
  reasons: string[];
  /** `lastAt` nereden: iş koşusu (`job_run`) ya da üretilen verinin zamanı. */
  source: "job_run" | "data";
}

function stageTime(raw: PipelineRawEvidence, stage: PipelineStage): Date | null {
  const run = raw.runs?.[stage];
  if (run?.lastGoodAt) return run.lastGoodAt;
  switch (stage) {
    case "collect":
      return raw.collect?.lastGoodAt ?? null;
    case "link":
      return raw.link?.lastFinishedAt ?? null;
    default:
      return raw[stage]?.lastAt ?? null;
  }
}

/** Saf değerlendirme; birim testlenir. */
export function evaluatePipeline(
  raw: PipelineRawEvidence,
  now: Date = new Date(),
): PipelineStageView[] {
  return PIPELINE_STAGES.map((stage) => {
    const run = raw.runs?.[stage] ?? null;
    const source = run?.lastGoodAt ? "job_run" : "data";
    if (raw[stage] === null && !run?.lastGoodAt) {
      return { stage, state: "unknown", lastAt: null, reasons: [], source };
    }
    const lastAt = stageTime(raw, stage);
    const reasons: string[] = [];
    if (run?.lastStatus === "failed") reasons.push("job_failed");
    if (
      run?.lastStatus === "running" &&
      now.getTime() - run.lastStartedAt.getTime() > STUCK_JOB_AFTER_MS
    ) {
      reasons.push("job_stuck");
    }

    if (stage === "collect" && raw.collect) {
      if (raw.collect.stuckRuns > 0) reasons.push("stuck_runs");
      if (lastAt && now.getTime() - lastAt.getTime() > STALE_FEED_AFTER_MS) {
        reasons.push("stale_feed");
      }
    }
    if (stage === "link" && raw.link) {
      if (raw.link.stuckProcessing > 0) reasons.push("link_stuck");
      if (
        raw.link.oldestQueuedAt &&
        now.getTime() - raw.link.oldestQueuedAt.getTime() > LINK_STUCK_AFTER_MS
      ) {
        reasons.push("link_queue_old");
      }
    }
    if (reasons.length > 0) return { stage, state: "warning", lastAt, reasons, source };
    if (!lastAt) {
      // Link işçisi hiç istek almadıysa kanıt yoktur ama sorun da yoktur.
      return { stage, state: "none", lastAt, reasons, source };
    }
    const upstreamNewer = UPSTREAM[stage].some((up) => {
      const upAt = stageTime(raw, up);
      return upAt !== null && upAt.getTime() > lastAt.getTime();
    });
    return { stage, state: upstreamNewer ? "behind" : "ok", lastAt, reasons, source };
  });
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function evidence<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T | null> {
  try {
    return await readOnly(db, 5_000, fn);
  } catch {
    return null;
  }
}

function date(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

async function maxAt(tx: Tx, query: ReturnType<typeof sql>): Promise<{ lastAt: Date | null }> {
  const result = await tx.execute<{ at: string | null }>(query);
  return { lastAt: date(result.rows[0]?.at) };
}

/**
 * Her aşama kendi salt okunur, zaman aşımlı işleminde: biri yavaşsa (ör. büyük
 * `embedding` tablosu) diğerleri yine görünür, o aşama "unknown" olur.
 */
export async function getPipelineEvidence(
  db: Database,
  actor: AdminActor,
): Promise<PipelineRawEvidence> {
  assertCapability(actor, "admin.access");
  const stuckSeconds = Math.round(STUCK_RUN_AFTER_MS / 1000);
  const linkStuckSeconds = Math.round(LINK_STUCK_AFTER_MS / 1000);
  const [collect, resolve, prices, enrich, edges, link, jobs] = await Promise.all([
    evidence(db, async (tx) => {
      const result = await tx.execute<{
        last_started: string | null;
        last_good: string | null;
        stuck: string;
      }>(sql`
        SELECT (SELECT max(started_at) FROM ingest_run) AS last_started,
               (SELECT max(started_at) FROM ingest_run
                 WHERE status IN ('success','partial')) AS last_good,
               (SELECT count(*) FROM ingest_run
                 WHERE status = 'running'
                   AND started_at < now() - make_interval(secs => ${stuckSeconds})) AS stuck
      `);
      const row = result.rows[0];
      return {
        lastStartedAt: date(row?.last_started),
        lastGoodAt: date(row?.last_good),
        stuckRuns: Number(row?.stuck ?? 0),
      };
    }),
    evidence(db, (tx) => maxAt(tx, sql`SELECT max(created_at) AS at FROM match_candidate`)),
    evidence(db, (tx) => maxAt(tx, sql`SELECT max(computed_at) AS at FROM product_price_stats`)),
    evidence(db, (tx) =>
      maxAt(
        tx,
        sql`SELECT max(created_at) AS at FROM embedding WHERE target_type IN ('offer','product')`,
      ),
    ),
    evidence(db, (tx) => maxAt(tx, sql`SELECT max(computed_at) AS at FROM similarity_edge`)),
    evidence(db, async (tx) => {
      const result = await tx.execute<{
        last_finished: string | null;
        stuck: string;
        oldest_queued: string | null;
      }>(sql`
        SELECT (SELECT max(finished_at) FROM link_resolution_request) AS last_finished,
               (SELECT count(*) FROM link_resolution_request
                 WHERE status = 'processing'
                   AND created_at < now() - make_interval(secs => ${linkStuckSeconds})) AS stuck,
               (SELECT min(created_at) FROM link_resolution_request
                 WHERE status = 'queued') AS oldest_queued
      `);
      const row = result.rows[0];
      return {
        lastFinishedAt: date(row?.last_finished),
        stuckProcessing: Number(row?.stuck ?? 0),
        oldestQueuedAt: date(row?.oldest_queued),
      };
    }),
    // `job_run` okunamazsa aşamalar veri zamanına düşer (sessizce değil:
    // kaynak "son kanıt" olarak etiketlenir).
    readJobRunSummary(db).catch(() => null),
  ]);
  return {
    collect,
    resolve,
    prices,
    enrich,
    edges,
    link,
    runs: jobs ? stageRunEvidence(jobs.jobs) : undefined,
  };
}
