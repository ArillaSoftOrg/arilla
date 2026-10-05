/**
 * Cevrimdisi model sorgu yorumu toplu isi (docs/decisions/0059, migration 0044).
 *
 * YALNIZCA korumali cron ucundan (`/api/cron/interpret-queries`) ya da elle
 * calisir. `/ara` istek yolu bunu cagirmaz; ileride yalnizca saklanan
 * dogrulanmis yorumu okur (CLAUDE.md kural 1).
 *
 * Akis:
 * 1. Aday: `search_query_day` (kimliksiz toplu ozet) son 30 gunde en az 3 kez
 *    aranmis, bu (taksonomi ozeti, model) icin henuz saklanmamis sorgular;
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
import { createHash } from "node:crypto";
import { apiUsage, type Database, queryInterpretation } from "@arilla/db";
import { sql } from "drizzle-orm";
import {
  buildInterpreterJsonSchema,
  describeTaxonomy,
  INTERPRETER_INSTRUCTIONS,
} from "../clarification/interpreter.ts";
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
import { interpretationIneligibility } from "./interpretation-eligibility.ts";
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

/**
 * Modele giden sozlesmenin ozeti: taksonomi (kimlik + etiket), JSON semasi ve
 * talimatlar. Biri degisince ayni sorgu yeniden yorumlanabilir.
 */
export function interpreterContractHash(
  registry: ClarificationRegistry = DEFAULT_CLARIFICATION_REGISTRY,
): string {
  const contract = JSON.stringify({
    instructions: INTERPRETER_INSTRUCTIONS,
    taxonomy: describeTaxonomy(registry),
    schema: buildInterpreterJsonSchema(registry),
  });
  return createHash("sha256").update(contract, "utf8").digest("hex");
}

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
  const result = await db.execute<{ query_norm: string; occurrences: number }>(sql`
    SELECT d.query_norm, SUM(d.searches)::int AS occurrences
      FROM search_query_day d
     WHERE d.day >= (${input.now.toISOString()}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date
                    - ${QUERY_INTERPRETATION_WINDOW_DAYS}::int
     GROUP BY d.query_norm
    HAVING SUM(d.searches) >= 3
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
    if (interpretationIneligibility({ queryNorm: row.query_norm, occurrences }) !== null) {
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
export type QueryInterpretationSkipReason = "missing_api_key" | "already_running";

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
    stopCode: null,
  };
}

/** Bir sorgunun sonucu ve HTTP denemelerinin muhasebesi tek islemde. */
async function persistOutcome(
  db: Database,
  input: { queryNorm: string; taxonomyHash: string; outcome: ModelInterpretationOutcome },
): Promise<{ stored: boolean; conflict: boolean }> {
  const { queryNorm, taxonomyHash, outcome } = input;
  return db.transaction(async (tx) => {
    if (outcome.calls.length > 0) {
      await tx.insert(apiUsage).values(
        outcome.calls.map((call: LlmCall) => ({
          sessionId: null,
          userId: null,
          operation: QUERY_INTERPRETATION_OPERATION,
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
  now?: () => Date;
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
