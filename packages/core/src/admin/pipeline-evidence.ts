/**
 * Veri boru hattının son kanıtı (docs/decisions/0051). İş geçmişi tablosu
 * yok (`job_run` ertelendi, 0039); her aşamanın sağlığı ÜRETTİĞİ verinin en
 * yeni zaman damgasından okunur ve öyle etiketlenir: "son kanıt", "son
 * çalıştı" değil. Aşamalar (`services/ingest`, hepsi elle/komut satırından):
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
  /** Kısa, sabit açıklama kodu: `stuck_runs`, `stale_feed`, `link_stuck`, `link_queue_old`. */
  reasons: string[];
}

function stageTime(raw: PipelineRawEvidence, stage: PipelineStage): Date | null {
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
    if (raw[stage] === null) return { stage, state: "unknown", lastAt: null, reasons: [] };
    const lastAt = stageTime(raw, stage);
    const reasons: string[] = [];

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
    if (reasons.length > 0) return { stage, state: "warning", lastAt, reasons };
    if (!lastAt) {
      // Link işçisi hiç istek almadıysa kanıt yoktur ama sorun da yoktur.
      return { stage, state: "none", lastAt, reasons };
    }
    const upstreamNewer = UPSTREAM[stage].some((up) => {
      const upAt = stageTime(raw, up);
      return upAt !== null && upAt.getTime() > lastAt.getTime();
    });
    return { stage, state: upstreamNewer ? "behind" : "ok", lastAt, reasons };
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
  const [collect, resolve, prices, enrich, edges, link] = await Promise.all([
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
  ]);
  return { collect, resolve, prices, enrich, edges, link };
}
