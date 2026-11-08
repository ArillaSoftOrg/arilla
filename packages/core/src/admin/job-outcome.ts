/**
 * İş sonucu sözleşmesinin okuyucusu (karar 0174, PR1b). Python işleri
 * (`services/ingest/db/job_run.py` `OUTCOMES`) `job_run.detail.outcome` ve
 * isteğe bağlı `detail.reason` yazar; `status` enum'u değişmez. Burası saf:
 * hem TypeScript yorumu (`runOutcome`) hem aynı kuralın SQL karşılığı
 * (`job-runs.ts`) bu dosyadaki listelerden türetilir.
 *
 * - `outcome` alanı YOKSA kayıt eski biçimdir ("Sonuç kaydı yok"), arıza
 *   değildir: eski `status` mantığıyla yorumlanır (karar 0174, mimari notlar).
 * - Alan VARSA ama bilinmeyen değer, metin olmayan tür ya da sözleşmedeki
 *   `status`'la çelişiyorsa `invalid`: başarılı SAYILMAZ (fail-closed).
 * - `skipped_locked` ve `blocked_upstream` geçerli tamamlanma (tazelik kanıtı)
 *   değildir. `completed` çıktı üretildiğini garanti etmez; çıktı yalnızca
 *   işin doğrulanmış sayaçlarından okunur (`OUTPUT_COUNTERS`).
 */
import type { JobRunStatus } from "@arilla/db";

export const JOB_OUTCOMES = [
  "completed",
  "no_input",
  "skipped_locked",
  "partial",
  "failed",
  "blocked_upstream",
] as const;
export type JobOutcomeName = (typeof JOB_OUTCOMES)[number];

/** Sözleşme: sonuç → yazılması gereken `job_run.status` (Python `OUTCOMES`). */
export const OUTCOME_STATUS: Readonly<Record<JobOutcomeName, JobRunStatus>> = {
  completed: "success",
  no_input: "success",
  skipped_locked: "partial",
  partial: "partial",
  failed: "failed",
  blocked_upstream: "partial",
};

/** Geçerli tamamlanma (`lastGoodAt`): iş tanımlı akışını bitirdi. */
export const GOOD_OUTCOMES: readonly JobOutcomeName[] = ["completed", "no_input", "partial"];

/**
 * Koşu iş akışını sonuna kadar yürüttü mü (`blocked_upstream` dahil). Birleşik
 * `similarity` işinde sonuç kenar adımından gelir; fiyat adımı kenar
 * engellense de koşmuştur (karar 0174 madde 7).
 */
export const RAN_OUTCOMES: readonly JobOutcomeName[] = [...GOOD_OUTCOMES, "blocked_upstream"];

const REASON = /^[a-z][a-z0-9_]{1,39}$/;

export type RunOutcomeKind = JobOutcomeName | "legacy" | "running" | "invalid";

/** Gösterim tonu; `info` renksiz, bilgi düzeyi. */
export type RunOutcomeTone = "good" | "info" | "warn" | "bad";

export interface RunOutcome {
  kind: RunOutcomeKind;
  /** Biçimi doğrulanmış gerekçe; yoksa ya da bozuksa `null`. */
  reason: string | null;
  /** Geçerli tamamlanma: `lastGoodAt`'e girer. */
  good: boolean;
  /** Akış sonuna kadar yürüdü (`blocked_upstream` dahil). */
  ran: boolean;
  tone: RunOutcomeTone;
}

const TONES: Record<RunOutcomeKind, RunOutcomeTone> = {
  completed: "good",
  no_input: "info",
  skipped_locked: "warn",
  partial: "warn",
  failed: "bad",
  blocked_upstream: "warn",
  invalid: "bad",
  running: "warn",
  legacy: "good",
};

function isJobOutcome(value: unknown): value is JobOutcomeName {
  return typeof value === "string" && (JOB_OUTCOMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `job_run` satırının sonucu. Saf; bozuk girdi istisna fırlatmaz. */
export function runOutcome(status: string, detail: unknown): RunOutcome {
  const record = isRecord(detail) ? detail : {};
  const rawReason = record.reason;
  const reason = typeof rawReason === "string" && REASON.test(rawReason) ? rawReason : null;
  if (status === "running") {
    return { kind: "running", reason: null, good: false, ran: false, tone: "warn" };
  }
  if (!Object.hasOwn(record, "outcome")) {
    // Eski biçim: karar 0055 mantığı (başarılı/kısmi iyi koşu).
    const good = status === "success" || status === "partial";
    const tone: RunOutcomeTone =
      status === "success" ? "good" : status === "partial" ? "warn" : "bad";
    return { kind: "legacy", reason: null, good, ran: good, tone };
  }
  const value = record.outcome;
  if (!isJobOutcome(value) || OUTCOME_STATUS[value] !== status) {
    return { kind: "invalid", reason, good: false, ran: false, tone: "bad" };
  }
  return {
    kind: value,
    reason,
    good: GOOD_OUTCOMES.includes(value),
    ran: RAN_OUTCOMES.includes(value),
    tone: TONES[value],
  };
}

/**
 * İş → aşama → doğrulanmış çıktı sayaçları. Sayaçlardan biri > 0 ise koşu çıktı
 * üretmiştir (`lastProducedAt`). Listede olmayan işin çıktı kanıtı yoktur
 * (`null`); `completed` tek başına yetmez.
 *
 * - resolve: `auto_accepted` teklifi mevcut ürüne BAĞLADI, `products_created`
 *   yeni ürün açıp bağladı. `queued` yalnızca insan kuyruğuna aday yazdı:
 *   bağlantı değildir, çıktı sayılmaz.
 * - similarity kenarları: `visual_edges`/`semantic_edges` yazılan kenar sayısı.
 *   `*_products` vektörlü ürün sayısıdır (girdi), çıktı değildir.
 * - fiyat özeti: `price_products` `product_price_stats`'a yazılan ürün sayısı.
 *   `price_aggregates` tam katalog onarımıdır, değişiklik kanıtı değildir.
 */
export type OutputStage = "resolve" | "prices" | "edges";

export const OUTPUT_COUNTERS: Readonly<
  Record<string, Readonly<Partial<Record<OutputStage, readonly string[]>>>>
> = {
  resolve: { resolve: ["auto_accepted", "products_created"] },
  similarity: {
    edges: ["visual_edges", "semantic_edges"],
    prices: ["price_products"],
  },
  similarity_edges: { edges: ["visual_edges", "semantic_edges"] },
  similarity_prices: { prices: ["price_products"] },
};
