/**
 * Cevrimdisi model sorgu yorumu toplu isi (docs/decisions/0059, migration 0044).
 *
 * YALNIZCA korumali cron ucundan (`/api/cron/interpret-queries`) ya da elle
 * calisir. `/ara` istek yolu bunu cagirmaz; ileride yalnizca saklanan
 * dogrulanmis yorumu okur (CLAUDE.md kural 1).
 *
 * Akis:
 * 1. Aday: `search_query_day` (tanimlayicisiz toplu gunluk ozet) son 30 gunde en az 3 kez
 *    ve en az 3 FARKLI gunde aranmis, bu (taksonomi ozeti, model) icin henuz
 *    saklanmamis sorgular;
 *    sira aranma sayisi azalan, sonra sorgu metni - deterministik.
 * 2. Suzgec: `interpretationIneligibility` (kisisel veri, kimlik, sir) ve
 *    deterministik netlestirme bu sorguda domain BULAMAMIS olmali (0030).
 * 3. Her aday icin `interpretWithModel`; sonuc ve o sorgunun HER HTTP
 *    denemesinin `api_usage` satiri ayni islemde yazilir.
 *
 * Saglayici hatasi satir uretmez ve sahte basari yazmaz; sonraki kosu yeniden
 * dener. Gecersiz cikti `invalid` olarak saklanir ki ayni surumde tekrar
 * odenmesin. Hicbir yere sorgu metni, istem ya da model yaniti loglanmaz;
 * `job_run.detail` yalnizca sayi tasir.
 */
import { apiUsage, type Database, queryInterpretation } from "@arilla/db";
import { sql } from "drizzle-orm";
import { describeTaxonomy } from "../clarification/interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { createInitialState } from "../clarification/state.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import { planConversation } from "../conversational-search/plan.ts";
import type { LlmCall, LlmClient, LlmErrorCode } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import { getLlmClient } from "../llm/gemini.ts";
import {
  interpretWithModel,
  LlmIntentInterpreter,
  type ModelInterpretationOutcome,
} from "../llm/intent-interpreter.ts";
import { withJobRun } from "../ops/job-run.ts";
import {
  INTERPRETATION_MIN_DISTINCT_DAYS,
  INTERPRETATION_MIN_OCCURRENCES,
  interpretationIneligibility,
} from "./interpretation-eligibility.ts";
import { interpreterContractHash } from "./interpretation-identity.ts";
import type { LexiconEntry } from "./lexicon.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { SEARCH_QUALITY_TIME_ZONE } from "./quality.ts";

export const QUERY_INTERPRETATION_JOB = "query_interpretation";
/** `api_usage.operation`. */
export const QUERY_INTERPRETATION_OPERATION = "query_interpretation";
/** Kosu basina en fazla yorumlanan sorgu (ilk surum icin temkinli). */
export const QUERY_INTERPRETATION_MAX_PER_RUN = 20;
export const QUERY_INTERPRETATION_WINDOW_DAYS = 30;
/** Suzgecten once okunan aday havuzu; dongu bununla sinirli. */
const CANDIDATE_POOL = 200;
/**
 * Yeni sorguya bu sureden sonra baslanmaz. Cron istemcisi (10 sn x 2 deneme)
 * ile en kotu sorgu ~21 sn: toplam, rotanin 60 sn sinirinin altinda kalir.
 */
export const QUERY_INTERPRETATION_TIME_BUDGET_MS = 35_000;
/** Bu sureden yeni `running` koşu varsa ikinci koşu baslamaz. */
const RUNNING_GUARD_MINUTES = 15;
/** Cron istemcisi: varsayilandan kisa; toplu isin sure butcesi icin. */
export const QUERY_INTERPRETATION_CLIENT_OPTIONS = { timeoutMs: 10_000, maxAttempts: 2 } as const;

/** Bu hatalarda kosu durur: yapilandirma sorunu ya da saglayici yavaslatiyor. */
const STOP_CODES = new Set<LlmErrorCode | "unknown">(["auth", "client_error", "rate_limited"]);

export interface CandidateSelection {
  candidates: string[];
  /** Havuzda okunan (esik ve onbellek SQL'de uygulandi). */
  scanned: number;
  ineligible: number;
  /** Deterministik netlestirme zaten domain buldu; model gereksiz. */
  deterministic: number;
}

/**
 * Deterministik: kural sozlugu bu sorguda domain buluyor mu. Hata olursa
 * "buluyor" sayilir (sorgu modele gitmez - temkinli taraf).
 */
function deterministicFindsDomain(
  queryNorm: string,
  registry: ClarificationRegistry,
  lexicon: readonly LexiconEntry[],
): boolean {
  try {
    const plan = planConversation({ query: queryNorm, steps: [] }, { registry, lexicon });
    return !(plan.mode === "conventional" && plan.reason === "no_domain");
  } catch {
    return true;
  }
}

export async function selectInterpretationCandidates(
  db: Database,
  input: {
    taxonomyHash: string;
    modelVersion: string;
    registry: ClarificationRegistry;
    lexicon: readonly LexiconEntry[];
    limit: number;
    now: Date;
  },
): Promise<CandidateSelection> {
  // (gun, sorgu) birincil anahtar: gruptaki satir sayisi = farkli gun sayisi.
  const result = await db.execute<{
    query_norm: string;
    occurrences: number;
    distinct_days: number;
  }>(sql`
    SELECT d.query_norm, SUM(d.searches)::int AS occurrences, COUNT(*)::int AS distinct_days
      FROM search_query_day d
     WHERE d.day >= (${input.now.toISOString()}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date
                    - ${QUERY_INTERPRETATION_WINDOW_DAYS}::int
     GROUP BY d.query_norm
    HAVING SUM(d.searches) >= ${INTERPRETATION_MIN_OCCURRENCES}::int
       AND COUNT(*) >= ${INTERPRETATION_MIN_DISTINCT_DAYS}::int
       AND NOT EXISTS (
             SELECT 1 FROM query_interpretation q
              WHERE q.query_norm = d.query_norm
                AND q.taxonomy_hash = ${input.taxonomyHash}
                AND q.model_version = ${input.modelVersion}
           )
     ORDER BY occurrences DESC, d.query_norm ASC
     LIMIT ${CANDIDATE_POOL}
  `);

  const selection: CandidateSelection = {
    candidates: [],
    scanned: result.rows.length,
    ineligible: 0,
    deterministic: 0,
  };
  for (const row of result.rows) {
    if (selection.candidates.length >= input.limit) break;
    const occurrences = Number(row.occurrences);
    const distinctDays = Number(row.distinct_days);
    if (
      interpretationIneligibility({ queryNorm: row.query_norm, occurrences, distinctDays }) !== null
    ) {
      selection.ineligible++;
      continue;
    }
    if (deterministicFindsDomain(row.query_norm, input.registry, input.lexicon)) {
      selection.deterministic++;
      continue;
    }
    selection.candidates.push(row.query_norm);
  }
  return selection;
}

export type QueryInterpretationRunStatus = "success" | "partial" | "failed" | "skipped";
export type QueryInterpretationSkipReason = "missing_api_key" | "already_running" | "daily_cap";

/** Yalnizca sayilar ve sabit kodlar; sorgu metni ya da model ciktisi YOK. */
export interface QueryInterpretationBatchResult {
  status: QueryInterpretationRunStatus;
  skippedReason: QueryInterpretationSkipReason | null;
  candidates: number;
  scanned: number;
  ineligible: number;
  deterministic: number;
  attempted: number;
  accepted: number;
  empty: number;
  invalid: number;
  providerErrors: number;
  /** `api_usage`'a yazilan HTTP denemesi sayisi. */
  providerCalls: number;
  /** Esanli kosu ayni satiri once yazdi (ON CONFLICT). */
  alreadyStored: number;
  /** Sure butcesi ya da durdurucu hata yuzunden islenmeyen aday. */
  deferred: number;
  /**
   * Bugun (Europe/Istanbul) yapilmis toplam saglayici denemesi, bu kosununkiler
   * DAHIL (kosu oncesi sayim + `providerCalls`). Yalnizca raporlama; tavan
   * kararlari kosu oncesi sayimla verilir.
   */
  providerCallsToday: number;
  /** Kosuyu durduran saglayici hata kodu (sabit). */
  stopCode: string | null;
}

function emptyResult(
  status: QueryInterpretationRunStatus,
  skippedReason: QueryInterpretationSkipReason | null = null,
): QueryInterpretationBatchResult {
  return {
    status,
    skippedReason,
    candidates: 0,
    scanned: 0,
    ineligible: 0,
    deterministic: 0,
    attempted: 0,
    accepted: 0,
    empty: 0,
    invalid: 0,
    providerErrors: 0,
    providerCalls: 0,
    alreadyStored: 0,
    deferred: 0,
    providerCallsToday: 0,
    stopCode: null,
  };
}

/**
 * Bir sorgunun sonucu ve HTTP denemelerinin muhasebesi tek islemde. Toplu is
 * ve anlik yorum (karar 0062) ayni yolu kullanir; yalnizca `api_usage`
 * islem adi farklidir (gunluk tavanlar ayri sayilir).
 */
export async function persistOutcome(
  db: Database,
  input: {
    queryNorm: string;
    taxonomyHash: string;
    outcome: ModelInterpretationOutcome;
    operation?: string;
  },
): Promise<{ stored: boolean; conflict: boolean }> {
  const { queryNorm, taxonomyHash, outcome } = input;
  const operation = input.operation ?? QUERY_INTERPRETATION_OPERATION;
  return db.transaction(async (tx) => {
    if (outcome.calls.length > 0) {
      await tx.insert(apiUsage).values(
        outcome.calls.map((call: LlmCall) => ({
          sessionId: null,
          userId: null,
          operation,
          modelVersion: call.modelVersion,
          units: call.usage?.totalTokens ?? 0,
          costMicros: 0,
          cacheHit: false,
        })),
      );
    }
    if (outcome.status === "provider_error") return { stored: false, conflict: false };

    const inserted = await tx
      .insert(queryInterpretation)
      .values({
        queryNorm,
        taxonomyHash,
        modelVersion: outcome.modelVersion,
        status: outcome.status,
        interpretation:
          outcome.status === "accepted"
            ? (outcome.value as unknown as Record<string, unknown>)
            : null,
        rejected: outcome.rejected.map(({ path, reason }) => ({ path, reason })),
      })
      .onConflictDoNothing()
      .returning({ id: queryInterpretation.id });
    return { stored: inserted.length > 0, conflict: inserted.length === 0 };
  });
}

export interface QueryInterpretationBatchOptions {
  registry?: ClarificationRegistry;
  maxQueries?: number;
  timeBudgetMs?: number;
  /** Testler icin; varsayilan `QUERY_INTERPRETATION_DAILY_CALL_CAP`. Yukseltilemez. */
  dailyCallCap?: number;
  now?: () => Date;
}

/**
 * Maliyet tavani: Europe/Istanbul gunu basina en fazla bu kadar saglayici HTTP
 * denemesi (yeniden denemeler dahil). Elle tekrarlanan kosular toplamda bunu
 * asamaz. Sayim migration'siz: her gercek deneme zaten tam bir `api_usage`
 * satiri yazar (`operation = 'query_interpretation'`, `(created_at,
 * operation)` indeksi). Tek kosu en fazla 20 sorgu x 2 deneme = 40.
 */
export const QUERY_INTERPRETATION_DAILY_CALL_CAP = 100;

/**
 * Bugun (Europe/Istanbul takvim gunu) yazilmis yorum denemesi sayisi.
 * Varsayilan islem toplu istir; anlik yorum kendi islem adiyla ayri sayar.
 */
export async function providerCallsToday(
  db: Database,
  now: Date,
  operation: string = QUERY_INTERPRETATION_OPERATION,
): Promise<number> {
  const result = await db.execute<{ calls: number }>(sql`
    SELECT count(*)::int AS calls
      FROM api_usage
     WHERE operation = ${operation}
       AND created_at >= (((${now.toISOString()}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date)::timestamp
                          AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})
  `);
  return Number(result.rows[0]?.calls ?? 0);
}

/**
 * Toplu isin govdesi. Istemci yoksa (anahtar tanimsiz) hicbir saglayici
 * cagrisi ve hicbir veritabani okumasi yapmadan `skipped` doner.
 */
export async function runQueryInterpretationBatch(
  db: Database,
  client: LlmClient | null,
  options: QueryInterpretationBatchOptions = {},
): Promise<QueryInterpretationBatchResult> {
  if (client === null) return emptyResult("skipped", "missing_api_key");

  const registry = options.registry ?? DEFAULT_CLARIFICATION_REGISTRY;
  const maxQueries = Math.max(
    0,
    Math.min(
      options.maxQueries ?? QUERY_INTERPRETATION_MAX_PER_RUN,
      QUERY_INTERPRETATION_MAX_PER_RUN,
    ),
  );
  const timeBudgetMs = options.timeBudgetMs ?? QUERY_INTERPRETATION_TIME_BUDGET_MS;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const dailyCap = Math.min(
    Math.max(0, options.dailyCallCap ?? QUERY_INTERPRETATION_DAILY_CALL_CAP),
    QUERY_INTERPRETATION_DAILY_CALL_CAP,
  );
  // Bir sorgunun en kotu durumda harcayabilecegi deneme (cron istemcisi: 2).
  const worstCallsPerQuery = QUERY_INTERPRETATION_CLIENT_OPTIONS.maxAttempts;
  const callsBefore = await providerCallsToday(db, now());
  if (callsBefore + worstCallsPerQuery > dailyCap) {
    return { ...emptyResult("skipped", "daily_cap"), providerCallsToday: callsBefore };
  }

  const taxonomyHash = interpreterContractHash(registry);
  const lexicon = await loadLexicon(db);
  const selection = await selectInterpretationCandidates(db, {
    taxonomyHash,
    modelVersion: client.modelVersion,
    registry,
    lexicon,
    limit: maxQueries,
    now: now(),
  });

  const result = emptyResult("success");
  result.candidates = selection.candidates.length;
  result.scanned = selection.scanned;
  result.ineligible = selection.ineligible;
  result.deterministic = selection.deterministic;

  const interpreter = new LlmIntentInterpreter(client, registry);
  const taxonomy = describeTaxonomy(registry);

  for (const [index, queryNorm] of selection.candidates.entries()) {
    if (now().getTime() - startedAt > timeBudgetMs) {
      result.deferred = selection.candidates.length - index;
      break;
    }
    // Gunluk tavan: bu sorgunun en kotu deneme sayisi sigmiyorsa durulur.
    if (callsBefore + result.providerCalls + worstCallsPerQuery > dailyCap) {
      result.stopCode = "daily_cap";
      result.deferred = selection.candidates.length - index;
      break;
    }
    // Modele yalnizca sorgu, bos baslangic durumu ve taksonomi gider.
    const outcome = await interpretWithModel(
      interpreter,
      { text: queryNorm, state: createInitialState(), taxonomy },
      registry,
    );
    result.attempted++;
    result.providerCalls += outcome.calls.length;

    const persisted = await persistOutcome(db, { queryNorm, taxonomyHash, outcome });
    if (persisted.conflict) result.alreadyStored++;

    if (outcome.status === "provider_error") {
      result.providerErrors++;
      if (STOP_CODES.has(outcome.code)) {
        result.stopCode = outcome.code;
        result.deferred = selection.candidates.length - index - 1;
        break;
      }
      continue;
    }
    result[outcome.status]++;
  }

  result.providerCallsToday = callsBefore + result.providerCalls;
  if (result.attempted > 0 && result.providerErrors === result.attempted) {
    result.status = "failed";
  } else if (result.providerErrors > 0) {
    result.status = "partial";
  }
  return result;
}

/** Ayni anda bir koşu: yakin zamanda baslamis `running` koşu var mi. */
async function anotherRunInProgress(db: Database): Promise<boolean> {
  const result = await db.execute<{ running: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM job_run
       WHERE job = ${QUERY_INTERPRETATION_JOB}
         AND status = 'running'
         AND started_at > now() - make_interval(mins => ${RUNNING_GUARD_MINUTES})
    ) AS running
  `);
  return result.rows[0]?.running === true;
}

/**
 * `job_run` kaydinda `skipped` durumu yok (0041: running/success/partial/
 * failed). Atlanan koşu `success` + `detail.skipped = true` ve neden koduyla
 * yazilir; diger durumlar aynen eslenir.
 */
function jobOutcome(result: QueryInterpretationBatchResult) {
  const { status, skippedReason, stopCode, ...counts } = result;
  return {
    status: status === "skipped" ? ("success" as const) : status,
    detail: {
      ...counts,
      skipped: status === "skipped",
      ...(skippedReason ? { skippedReason } : {}),
      ...(stopCode ? { stopCode } : {}),
    },
  };
}

/**
 * Cron ucunun tek giris noktasi. Anahtar yalnizca sunucu ortamindan okunur;
 * yoksa saglayici cagrilmaz. Esanli koşu varsa atlanir. Govde hata verirse
 * hata yalnizca sinifi ve SQL durum koduyla yeniden atilir (metin yok).
 */
export async function runQueryInterpretationJob(
  db: Database,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: QueryInterpretationBatchOptions & { client?: LlmClient | null } = {},
): Promise<QueryInterpretationBatchResult> {
  let client: LlmClient | null;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    try {
      client = getLlmClient(env, QUERY_INTERPRETATION_CLIENT_OPTIONS);
    } catch (error) {
      if (error instanceof LlmError && error.code === "missing_api_key") client = null;
      else throw error;
    }
  }

  if (client !== null && (await anotherRunInProgress(db))) {
    const skipped = emptyResult("skipped", "already_running");
    return withJobRun(db, QUERY_INTERPRETATION_JOB, "cron", async () => skipped, jobOutcome);
  }

  return withJobRun(
    db,
    QUERY_INTERPRETATION_JOB,
    "cron",
    async () => {
      try {
        return await runQueryInterpretationBatch(db, client, options);
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? "";
        throw new Error(`query_interpretation ${name}${code ? ` ${code}` : ""}`);
      }
    },
    jobOutcome,
  );
}

/**
 * Saklama (karar 0059): yorum satirlari `created_at`'ten itibaren 90 gun
 * tutulur - kaynaklari olan `search_query_day` ile ayni sure. Suresi dolan
 * satir silinir; sorgu hala sik araniyorsa toplu is onu yeniden yorumlar.
 * Yalnizca `query_interpretation` silinir; baska arama verisine dokunulmaz.
 */
export const QUERY_INTERPRETATION_RETENTION_DAYS = 90;

export interface QueryInterpretationPurgeResult {
  deleted: number;
  /** Parti tavanina ulasildi; kalan satirlar sonraki calistirmada silinir. */
  truncated: boolean;
}

/** Suresi dolmus yorumlari sinirli partilerle siler. Hata firlatir (cagiran karar verir). */
export async function purgeExpiredQueryInterpretations(
  db: Database,
  now: Date = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<QueryInterpretationPurgeResult> {
  const batchSize = options.batchSize ?? 5_000;
  const maxBatches = options.maxBatches ?? 20;
  const cutoff = new Date(
    now.getTime() - QUERY_INTERPRETATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.execute(sql`
      DELETE FROM query_interpretation
       WHERE id IN (
         SELECT id FROM query_interpretation
          WHERE created_at < ${cutoff.toISOString()}::timestamptz
          ORDER BY id
          LIMIT ${batchSize}
       )
    `);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

/**
 * Gunluk temizlik icin: yorum saklamasi digerlerinden YALITILIR. Tablo yoksa
 * ya da yetki eksikse diger saklama isleri yine calisir; hata yalnizca sinifi
 * ve SQL koduyla loglanir ve sonucta `failed` olarak doner (koşu `partial`).
 */
export async function purgeExpiredQueryInterpretationsSafely(
  db: Database,
  now: Date = new Date(),
): Promise<QueryInterpretationPurgeResult & { failed: string | null }> {
  try {
    return { ...(await purgeExpiredQueryInterpretations(db, now)), failed: null };
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
      (error as { code?: string })?.code ??
      "error";
    console.warn(
      "[query-interpretation] retention purge failed",
      error instanceof Error ? error.name : "unknown",
      code,
    );
    return { deleted: 0, truncated: false, failed: /^[0-9A-Z]{5}$/.test(code) ? code : "error" };
  }
}
