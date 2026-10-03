/**
 * `job_run` yazımı — TypeScript tarafı (migration 0041, karar 0052/0055).
 * Zamanlanmış uçlar (`/api/cron/*`) koşularını buraya yazar; Python boru
 * hattı işleri aynı tabloya `services/ingest/db/job_run.py` ile yazar. İki
 * taraf birbirini çağırmaz, yalnızca tabloyu paylaşır.
 *
 * Kurallar:
 * 1. **İşi asla düşürmez.** Kayıt yazılamazsa (bağlantı, kısıt) iş yine
 *    çalışır; yalnızca kısa bir uyarı loglanır (sır ya da adres yok).
 * 2. **Sırsız ve sınırlı.** `error_summary` adresleri ana makineye indirir,
 *    e-posta ve `anahtar=değer` sırlarını maskeler, ≤ 500 karakter. `detail`
 *    yalnızca düz sayı/bool/kısa metin (bir düzey iç içe nesne düzleştirilir),
 *    JSON metni ≤ 3000 karakter (kısıt 4 KB).
 * 3. **Gözlem önce.** Yeniden dene / şimdi çalıştır YOK; bu modül yalnızca
 *    koşunun izini bırakır.
 *
 * Saklama: 180 gün (`purgeJobRuns`, günlük temizlik cron'u).
 */
import type { Database, JobRunStatus, JobRunTrigger } from "@arilla/db";
import { sql } from "drizzle-orm";

export const JOB_NAME_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const JOB_RUN_RETENTION_DAYS = 180;
export const JOB_ERROR_SUMMARY_MAX = 500;
const DETAIL_JSON_MAX = 3000;
const DETAIL_KEYS_MAX = 40;
const DETAIL_STRING_MAX = 120;

export type JobDetailValue = number | boolean | string | null;
export type JobDetail = Record<string, JobDetailValue>;

const URL_PATTERN = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s/?#'"<>]+)[^\s'"<>]*/gi;
const EMAIL_PATTERN = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
const SECRET_PATTERN =
  /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*\S+/gi;

/** Hata metnini kayda uygun hale getirir. Boşsa `null`. */
export function redactJobError(
  text: string | null | undefined,
  maxLength = JOB_ERROR_SUMMARY_MAX,
): string | null {
  if (!text) return null;
  const cleaned = String(text)
    .replace(URL_PATTERN, (_match, scheme: string, authority: string) => {
      const host = authority.split("@").pop() ?? "";
      return `${scheme}://${host}/…`;
    })
    .replace(EMAIL_PATTERN, "<e-posta>")
    .replace(SECRET_PATTERN, (_match, key: string) => `${key}=<gizli>`)
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function scalar(value: unknown): JobDetailValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return redactJobError(value, DETAIL_STRING_MAX) ?? undefined;
  return undefined;
}

/**
 * Düz, küçük `detail`. Bir düzey iç içe nesne `üst_alt` anahtarlarına
 * düzleştirilir (`{ retention: { authEventsDeleted: 2 } }` →
 * `retention_authEventsDeleted`); dizi ve daha derin yapı yazılmaz.
 */
export function boundedJobDetail(input: unknown): JobDetail {
  const out: JobDetail = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const put = (key: string, value: unknown) => {
    if (Object.keys(out).length >= DETAIL_KEYS_MAX) return;
    const v = scalar(value);
    if (v !== undefined) out[key.slice(0, 40)] = v;
  };
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [inner, innerValue] of Object.entries(value)) put(`${key}_${inner}`, innerValue);
    } else {
      put(key, value);
    }
  }
  const keys = Object.keys(out);
  while (keys.length > 0 && JSON.stringify(out).length > DETAIL_JSON_MAX) {
    const last = keys.pop();
    if (last !== undefined) delete out[last];
  }
  return out;
}

function warn(message: string, error: unknown): void {
  const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code;
  console.warn(`[job_run] ${message}${code ? ` (${code})` : ""}`);
}

/** Koşuyu `running` olarak açar. Geçersiz ad ya da yazım hatasında `null` (iş sürer). */
export async function startJobRun(
  db: Database,
  job: string,
  trigger: JobRunTrigger = "cron",
): Promise<number | null> {
  if (!JOB_NAME_PATTERN.test(job)) {
    console.warn("[job_run] geçersiz iş adı, kayıt yok");
    return null;
  }
  try {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO job_run (job, trigger) VALUES (${job}, ${trigger}) RETURNING id
    `);
    const id = result.rows[0]?.id;
    return id === undefined ? null : Number(id);
  } catch (error) {
    warn("başlatılamadı", error);
    return null;
  }
}

/** Koşuyu kapatır. Yalnızca hâlâ `running` olan satır güncellenir; hata yutulur. */
export async function finishJobRun(
  db: Database,
  id: number | null,
  status: Exclude<JobRunStatus, "running">,
  detail?: unknown,
  errorSummary?: string | null,
): Promise<void> {
  if (id === null) return;
  try {
    await db.execute(sql`
      UPDATE job_run
         SET status = ${status}, finished_at = now(),
             detail = ${JSON.stringify(boundedJobDetail(detail))}::jsonb,
             error_summary = ${redactJobError(errorSummary)}
       WHERE id = ${id} AND status = 'running'
    `);
  } catch (error) {
    warn("kapatılamadı", error);
  }
}

export interface JobOutcome {
  status?: Exclude<JobRunStatus, "running">;
  detail?: unknown;
  errorSummary?: string | null;
}

/**
 * İşi koşu kaydıyla sarar. `summarize` sonucu duruma/ayrıntıya çevirir
 * (verilmezse `success` + sonucun düz alanları). İş hata fırlatırsa `failed`
 * + kırpılmış hata özeti yazılır ve hata AYNEN yeniden fırlatılır.
 */
export async function withJobRun<T>(
  db: Database,
  job: string,
  trigger: JobRunTrigger,
  fn: () => Promise<T>,
  summarize?: (result: T) => JobOutcome,
): Promise<T> {
  const id = await startJobRun(db, job, trigger);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    await finishJobRun(db, id, "failed", {}, `${name}: ${message}`);
    throw error;
  }
  let outcome: JobOutcome = {};
  try {
    outcome = summarize ? summarize(result) : {};
  } catch {
    outcome = {};
  }
  await finishJobRun(
    db,
    id,
    outcome.status ?? "success",
    outcome.detail ?? result,
    outcome.errorSummary ?? null,
  );
  return result;
}

export interface JobRunPurgeResult {
  deleted: number;
  /** Parti tavanına ulaşıldı; kalan satırlar sonraki çalıştırmada silinir. */
  truncated: boolean;
}

/**
 * 180 günden eski koşuları siler (sınırlı partiler). 180 gün önce başlamış
 * ve hâlâ `running` görünen satır da silinir: süreci çoktan ölmüştür ve
 * işletim ekranı onu zaten aylarca "kapanmamış" diye göstermiştir.
 */
export async function purgeJobRuns(
  db: Database,
  now: Date = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<JobRunPurgeResult> {
  const batchSize = options.batchSize ?? 5_000;
  const maxBatches = options.maxBatches ?? 20;
  const cutoff = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.execute(sql`
      DELETE FROM job_run
       WHERE id IN (
         SELECT id FROM job_run
          WHERE started_at < ${cutoff.toISOString()}::timestamptz
          LIMIT ${batchSize}
       )
    `);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}
