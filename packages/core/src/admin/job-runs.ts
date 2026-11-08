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
import {
  GOOD_OUTCOMES,
  JOB_OUTCOMES,
  type JobOutcomeName,
  OUTCOME_STATUS,
  OUTPUT_COUNTERS,
  type OutputStage,
  RAN_OUTCOMES,
  type RunOutcome,
  runOutcome,
} from "./job-outcome.ts";
import { redactText } from "./redact.ts";

/** Bu süreden uzun `running` kalan koşu takılı sayılır (süreç ölmüş, kapanmamış). */
export const STUCK_JOB_AFTER_MS = 2 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;

export interface KnownJob {
  label: string;
  /** Elle çalıştırma komutu ya da tetikleyen. */
  how: string;
  /** `cron`: zamanlanmış (VPS cron konteyneri ya da systemd zamanlayıcısı); `pipeline`: elle. */
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
  // Karar 0112: besleme keşfi ve artımlı senkronizasyon (zamanlama aktivasyonla gelir).
  feed_discover: {
    label: "Besleme keşfi (affiliate ağları)",
    how: "python -m feeds discover",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  feed_sync: {
    label: "Besleme senkronizasyonu",
    how: "python -m feeds sync-due",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Karar 0145: günlük AliExpress fiyat tazeleme (keşif + senkronizasyon + tazelik ölçümü).
  // Zamanlayıcı ayrı ve onaylı bir adımla etkinleşir (`feeds-timers install`); kurulana kadar
  // kayıt yoktur. Günde iki tetik (06:30, 18:30 UTC); 36 saat koşusuz kalırsa gecikmiş sayılır.
  feed_daily: {
    label: "Günlük fiyat tazeleme (AliExpress)",
    how: "python -m feeds daily --merchant aliexpress · VPS zamanlayıcı (günde iki kez)",
    kind: "cron",
    overdueAfterMs: 36 * HOUR,
  },
  // Karar 0115: yonetici toplamasi ara deposunun katalog modeline birlestirilmesi (elle).
  hb_merge: {
    label: "Hepsiburada toplama birleştirme",
    how: "python -m feeds hb-merge --run <id>",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Karar 0113: resmi kur ve bagimsiz fiyat dogrulama. VPS systemd zamanlayicilari
  // (infra/vps/systemd/arilla-pricing-*); kurulum `batch-timers install`.
  fx_rates: {
    label: "Döviz kuru (TCMB)",
    how: "python -m pricing fx · VPS zamanlayıcı (günlük 13:30 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  price_verify: {
    label: "Fiyat doğrulama",
    how: "python -m pricing verify · VPS zamanlayıcı (saatlik)",
    kind: "cron",
    overdueAfterMs: 3 * HOUR,
  },
  // Karar 0128: affiliate agi eylemleri -> `conversion` (infra/vps/systemd/arilla-affiliate-conversions).
  affiliate_conversions: {
    label: "Affiliate dönüşümleri (Admitad)",
    how: "python -m affiliate conversions · VPS zamanlayıcı (günlük 05:00 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  // Karar 0121: kaynak ilanından taslak ürün, kalite kapısı ve açık yayın (elle).
  catalog_build: {
    label: "Katalog aktarımı (kaynak ilanı -> taslak ürün)",
    how: "python -m catalog_build build --merchant aliexpress|hepsiburada",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Karar 0130: fiyatsız keşif defterinden yalnızca taslak ürün (teklif/fiyat yok).
  catalog_build_discovery: {
    label: "Keşif defteri aktarımı (fiyatsız taslak ürün)",
    how: "python -m catalog_build build-discovery --merchant hepsiburada --limit N",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  catalog_gate: {
    label: "Katalog kalite kapısı",
    how: "python -m catalog_build gate",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  catalog_publish: {
    label: "Katalog yayını (açık onayla)",
    how: "python -m catalog_build publish --limit N --confirm",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Karar 0164: besleme senkronizasyonundan sonra yeni teklif -> taslak -> üst kategori -> kapı ->
  // yayın. Zamanlayıcı ayrı ve onaylı bir adımla etkinleşir (`catalog-auto-timers install`);
  // kurulana kadar kayıt yoktur. Adımların kendi koşuları (catalog_build, classify_parent,
  // catalog_gate, catalog_publish) `detail.via = "catalog_auto"` ile ayrıca yazılır.
  catalog_auto: {
    label: "Otomatik katalog hattı (yeni teklif → yayınlanmış ürün)",
    how: "python -m catalog_build auto · VPS zamanlayıcı (besleme ardından; 12:15 ve 21:15 UTC güvenlik ağı)",
    kind: "cron",
    overdueAfterMs: 36 * HOUR,
  },
  // Karar 0161: kaynak üst eşlemesiyle yalnızca güvenilir üst kategori yazımı (geri alınabilir).
  classify_parent: {
    label: "Kaynak üst kategori yazımı",
    how: "python -m classify parents --confirm · otomatik hat adımı (karar 0164)",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Karar 0133: marka + merkezi kategori; model çağrısı yok, elle başlatılır.
  classify_products: {
    label: "Ürün sınıflandırma (marka ve kategori)",
    how: "python -m classify products --confirm",
    kind: "pipeline",
    overdueAfterMs: null,
  },
  // Gece katalog hatti (infra/vps/systemd/arilla-catalog-pipeline): resolve, sonra kenarlar.
  resolve: {
    label: "Eşleştirme",
    how: "python -m resolve · VPS zamanlayıcı (günlük 02:30 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
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
    how: "python -m similarity --edges · VPS zamanlayıcı (günlük 02:30 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
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
  // Karar 0059: VPS cron (infra/vps/cron/crontab), günlük 00:30 UTC. Anahtar yoksa koşu "atlandı"
  // olarak yine yazılır; gecikme eşiği diğer günlük cron'larla aynı.
  query_interpretation: {
    label: "Sorgu yorumlama (model, çevrimdışı)",
    how: "VPS cron (günlük 00:30 UTC); GEMINI_API_KEY yoksa atlanır",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  // Fiyat özeti olağan olarak teklifi yazan işlemde yenilenir; bu koşu
  // atlanmış yolları bir gün içinde onarır (refresh-aggregates.ts).
  product_aggregates: {
    label: "Fiyat özeti onarımı",
    how: "VPS cron (günlük 23:45 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  discovery_slots: {
    label: "Keşfet slotları",
    how: "VPS cron (günlük 00:00 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  cleanup_auth: {
    label: "Günlük temizlik (giriş, arama hakkı, saklama)",
    how: "VPS cron (günlük 03:30 UTC)",
    kind: "cron",
    overdueAfterMs: 30 * HOUR,
  },
  trigger_alerts: {
    label: "Fiyat alarmları",
    how: "VPS cron (15 dk)",
    kind: "cron",
    overdueAfterMs: 2 * HOUR,
  },
  marketing_campaigns: {
    label: "Pazarlama e-postası teslimi",
    how: "VPS cron (15 dk)",
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
  /** Karar 0174 sonucu (`runOutcome`); eski kayıtta `kind: "legacy"`. */
  outcome: RunOutcome;
}

export interface JobLastRun {
  job: string;
  lastRun: JobRunRow | null;
  /**
   * Son GEÇERLİ tamamlanmanın bitişi: eski kayıtta `success`/`partial`; sonuçlu
   * kayıtta `completed`/`no_input`/`partial`. `skipped_locked`,
   * `blocked_upstream`, `failed` ve bozuk sonuç hariç (karar 0174).
   */
  lastGoodAt: Date | null;
  /**
   * Akışı sonuna kadar yürüyen son koşunun bitişi (`blocked_upstream` dahil).
   * Birleşik `similarity` işinin fiyat adımı için tazelik kanıtıdır.
   */
  lastRanAt: Date | null;
  /**
   * Gecikme hesabının referansı: `skipped_locked` OLMAYAN son koşunun başlangıcı.
   * İşin hiç böyle koşusu yoksa ilk koşusunun başlangıcı (atlanan koşu gecikmeyi
   * sıfırlamaz).
   */
  lastAttemptAt: Date | null;
  /**
   * Doğrulanmış çıktı sayacı > 0 olan son koşunun bitişi (`OUTPUT_COUNTERS`).
   * Çıktı sayacı tanımsız işte `null`.
   */
  lastProducedAt: Date | null;
  /** Aşama bazında son çıktı (birleşik `similarity`: kenar ve fiyat ayrı). */
  producedAt: Partial<Record<OutputStage, Date | null>>;
  /** Son iyi koşudan sonraki başarısız (ya da bozuk sonuçlu) koşu sayısı (en fazla 50). */
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
    detail:
      row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail : {},
    // Yazarken kırpıldı; gösterimde ikinci kez (eski/elle yazılmış satır için).
    errorSummary: redactText(row.error_summary, 500),
    outcome: runOutcome(row.status, row.detail),
  };
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/*
 * `runOutcome`'un SQL karşılığı (aynı listelerden türetilir). `detail` CHECK ile
 * her zaman nesnedir; `detail->'outcome' IS NULL` yalnızca anahtar YOKKEN doğrudur
 * (JSON `null` değeri SQL NULL değildir → bozuk sayılır). Tür önce denetlenir:
 * metin olmayan değer karşılaştırmaya girmez, dönüşüm hatası sorguyu düşürmez.
 * `alias` yalnızca bu dosyadaki sabit tablo takma adlarıdır (kullanıcı girdisi değil).
 */
function legacySql(alias: string) {
  return sql.raw(`(${alias}.detail->'outcome' IS NULL)`);
}

function outcomeSql(alias: string, outcomes: readonly JobOutcomeName[]) {
  const a = sql.raw(alias);
  const pairs = outcomes.map((o) => sql`(${o}::text, ${OUTCOME_STATUS[o]}::text)`);
  return sql`(jsonb_typeof(${a}.detail->'outcome') = 'string'
    AND (${a}.detail->>'outcome', ${a}.status) IN (${sql.join(pairs, sql`, `)}))`;
}

/** Geçerli tamamlanma: eski kayıtta success/partial, sonuçlu kayıtta `GOOD_OUTCOMES`. */
function goodRunSql(alias: string) {
  return sql`((${legacySql(alias)} AND ${sql.raw(alias)}.status IN ('success','partial'))
    OR ${outcomeSql(alias, GOOD_OUTCOMES)})`;
}

/** Akış sonuna kadar yürüdü: `goodRunSql` + `blocked_upstream`. */
function ranRunSql(alias: string) {
  return sql`((${legacySql(alias)} AND ${sql.raw(alias)}.status IN ('success','partial'))
    OR ${outcomeSql(alias, RAN_OUTCOMES)})`;
}

/** Başarısız ya da bozuk sonuçlu (sözleşmeye uymayan) bitmiş koşu. */
function failedRunSql(alias: string) {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'failed'
    OR (${a}.status <> 'running' AND NOT ${legacySql(alias)}
        AND NOT ${outcomeSql(alias, JOB_OUTCOMES)}))`;
}

/**
 * Sayaçlardan biri pozitif JSON sayısı. Tür önce denetlenir (CASE ile sıralı):
 * metin, null, nesne ya da dizi `numeric`'e dönüştürülmez.
 */
function outputSql(alias: string, counters: readonly string[]) {
  const a = sql.raw(alias);
  const parts = counters.map(
    (key) => sql`CASE WHEN jsonb_typeof(${a}.detail->(${key}::text)) = 'number'
      THEN (${a}.detail->>(${key}::text))::numeric > 0 ELSE false END`,
  );
  return sql`(${sql.join(parts, sql` OR `)})`;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * `OUTPUT_COUNTERS`'taki her (iş, aşama) için çıktı sayacı > 0 olan son geçerli
 * koşu. Her alt sorgu `job_run_job_idx` üzerinde tek iş, yeniden eskiye ilk
 * eşleşmede durur.
 */
async function readProducedAt(tx: Tx): Promise<Map<string, Date | null>> {
  const entries = Object.entries(OUTPUT_COUNTERS).flatMap(([job, stages]) =>
    Object.entries(stages).map(([stage, counters]) => ({ job, stage, counters: counters ?? [] })),
  );
  const out = new Map<string, Date | null>();
  if (entries.length === 0) return out;
  const result = await tx.execute<{ job: string; stage: string; at: string | null }>(
    sql.join(
      entries.map(
        (e) => sql`SELECT ${e.job}::text AS job, ${e.stage}::text AS stage,
          (SELECT r.finished_at FROM job_run r
            WHERE r.job = ${e.job} AND ${ranRunSql("r")} AND ${outputSql("r", e.counters)}
            ORDER BY r.started_at DESC LIMIT 1) AS at`,
      ),
      sql` UNION ALL `,
    ),
  );
  for (const row of result.rows) out.set(`${row.job}:${row.stage}`, dateOrNull(row.at));
  return out;
}

function producedFor(
  job: string,
  produced: Map<string, Date | null>,
): Pick<JobLastRun, "lastProducedAt" | "producedAt"> {
  const stages = OUTPUT_COUNTERS[job];
  if (!stages) return { lastProducedAt: null, producedAt: {} };
  const producedAt: Partial<Record<OutputStage, Date | null>> = {};
  let latest: Date | null = null;
  for (const stage of Object.keys(stages) as OutputStage[]) {
    const at = produced.get(`${job}:${stage}`) ?? null;
    producedAt[stage] = at;
    if (at && (!latest || at > latest)) latest = at;
  }
  return { lastProducedAt: latest, producedAt };
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
      RunSqlRow & {
        name: string;
        last_good_at: string | null;
        last_ran_at: string | null;
        last_attempt_at: string | null;
        failures: string;
      }
    >(sql`
      SELECT j.name, lr.id, lr.job, lr.trigger, lr.status, lr.started_at, lr.finished_at,
             lr.detail, left(lr.error_summary, 500) AS error_summary,
             lg.finished_at AS last_good_at,
             (SELECT r.finished_at FROM job_run r
               WHERE r.job = j.name AND ${ranRunSql("r")}
               ORDER BY r.started_at DESC LIMIT 1) AS last_ran_at,
             coalesce(
               (SELECT r.started_at FROM job_run r
                 WHERE r.job = j.name AND NOT ${outcomeSql("r", ["skipped_locked"])}
                 ORDER BY r.started_at DESC LIMIT 1),
               (SELECT min(r.started_at) FROM job_run r WHERE r.job = j.name)
             ) AS last_attempt_at,
             (SELECT count(*) FROM (
                SELECT 1 FROM job_run f
                 WHERE f.job = j.name AND ${failedRunSql("f")}
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
           WHERE r.job = j.name AND ${goodRunSql("r")}
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
    const produced = await readProducedAt(tx);
    const order = (job: string) => {
      const i = known.indexOf(job);
      return i === -1 ? known.length : i;
    };
    return {
      jobs: result.rows
        .map((row) => ({
          job: row.name,
          lastRun: row.id ? toRun(row) : null,
          lastGoodAt: dateOrNull(row.last_good_at),
          lastRanAt: dateOrNull(row.last_ran_at),
          lastAttemptAt: dateOrNull(row.last_attempt_at),
          ...producedFor(row.name, produced),
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
