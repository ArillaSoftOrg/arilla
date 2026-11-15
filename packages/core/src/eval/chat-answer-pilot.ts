/**
 * Karar 0203 pilotu olcum seti: SAF mantik (ag, DB, ortam, dosya yok). Calistirici betik
 * (`scripts/chat-answer-eval.ts`) yalnizca G/C ve istemci kurulumunu yapar.
 *
 * Kapsam: maliyet hesabi, tavan (cap) zorlamasi, vaka basina kayit, toplu olcumler, insan
 * denetim sayfasi (JSON + Markdown) ve denetim sonucu ozeti. Gercek modele YALNIZ betik, acik
 * `--real` ve iki tavanla gider; bu modul hicbir saglayiciyi kendisi cagirmaz.
 */
import {
  inspectAnswer,
  looksLikeResultQuestion,
  type ParagraphInspection,
  type ResultFact,
} from "../chat/answer.ts";
import { emptyIntent } from "../chat/intent.ts";
import { type ChatInterpreter, type InterpretRequest, interpretTurn } from "../chat/interpreter.ts";
import type { LlmCall } from "../llm/client.ts";
import { GEMINI_MODEL } from "../llm/model.ts";
import { findLlmPriceRule, type LlmPriceRule } from "../llm/pricing.ts";
import { factsForCase, type PilotCase } from "./chat-answer-pilot-cases.ts";

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

/** Karakterden token tahmini (yalniz tavan kontrolu ve kuru kosu); gercek kosu saglayici sayar. */
export const CHARS_PER_TOKEN = 3;
/** Tavan icin en kotu durum cikti: `maxOutputTokens` (1536) + dusunme payi. */
export const WORST_CASE_OUTPUT_TOKENS = 2048;
/** Yazim hatasina karsi sert ust sinirlar; asmak icin betigi duzenlemek gerekir. */
export const CALLS_CEILING = 600;
export const USD_CEILING = 2;
export const BASELINE_CEILING = 50;

// ---------------------------------------------------------------------------
// Maliyet
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

/** Fiyat kurali (surumlu, `llm/pricing.ts`); bulunamazsa hata: 0 maliyet uydurulmaz. */
export function priceRule(model: string = GEMINI_MODEL, at: Date = new Date()): LlmPriceRule {
  const rule = findLlmPriceRule(model, at);
  if (!rule) throw new Error(`no price rule for model ${model}`);
  return rule;
}

/** USD'nin milyonda biri; dusunme token'lari cikti fiyatiyla. Yukari yuvarlanir. */
export function costUsdMicros(usage: TokenUsage, rule: LlmPriceRule): number {
  const input = usage.inputTokens * rule.inputUsdMicrosPerMTok;
  const output = (usage.outputTokens + usage.thoughtTokens) * rule.outputUsdMicrosPerMTok;
  return Math.ceil((input + output) / 1_000_000);
}

export const usdFromMicros = (micros: number): number => micros / 1_000_000;

export function sumCalls(calls: readonly LlmCall[]): TokenUsage & { attempts: number } {
  const total = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, attempts: calls.length };
  for (const call of calls) {
    if (!call.usage) continue;
    total.inputTokens += call.usage.inputTokens;
    total.outputTokens += call.usage.outputTokens;
    total.thoughtTokens += call.usage.thoughtTokens;
  }
  return total;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Komut satiri ve tavan
// ---------------------------------------------------------------------------

export interface PilotOptions {
  mode: "dry" | "real";
  maxCalls: number | null;
  maxUsd: number | null;
  baseline: number;
  limit: number | null;
  ids: string[] | null;
  types: string[] | null;
  ignoreTrigger: boolean;
  /** Karar 0213: AliExpress urunlerine sentetik yaklasik TL fiyat + kur tarihi ver. */
  approxPrices: boolean;
  repeat: number;
  outDir: string | null;
  summarize: string | null;
}

export type ParseResult = { ok: true; options: PilotOptions } | { ok: false; error: string };

const VALUE_FLAGS = new Set([
  "--max-calls",
  "--max-usd",
  "--baseline",
  "--limit",
  "--ids",
  "--types",
  "--repeat",
  "--out",
  "--summarize",
]);
const BOOL_FLAGS = new Set(["--real", "--dry-run", "--ignore-trigger", "--approx-prices"]);

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * Gercek kosu: `--real` + HEM `--max-calls` HEM `--max-usd` zorunlu (varsayilan yok), ust sinirlar
 * `CALLS_CEILING`/`USD_CEILING`. Kuru kosu (varsayilan) tavansiz calisir; verilirse zorlanir.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (BOOL_FLAGS.has(arg)) flags.add(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: `${arg} needs a value` };
      }
      values.set(arg, next);
      i++;
    } else return { ok: false, error: `unknown argument ${arg}` };
  }
  if (flags.has("--real") && flags.has("--dry-run")) {
    return { ok: false, error: "--real and --dry-run are mutually exclusive" };
  }
  const mode = flags.has("--real") ? "real" : "dry";

  let maxCalls: number | null = null;
  if (values.has("--max-calls")) {
    maxCalls = positiveInt(values.get("--max-calls"));
    if (maxCalls === null) return { ok: false, error: "--max-calls must be a positive integer" };
  }
  let maxUsd: number | null = null;
  if (values.has("--max-usd")) {
    const raw = values.get("--max-usd") as string;
    maxUsd = /^\d{1,3}(\.\d{1,6})?$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
      return { ok: false, error: "--max-usd must be a positive decimal number" };
    }
  }
  if (mode === "real") {
    if (maxCalls === null || maxUsd === null) {
      return { ok: false, error: "real mode requires both --max-calls N and --max-usd X" };
    }
    if (maxCalls > CALLS_CEILING) {
      return { ok: false, error: `--max-calls above ceiling ${CALLS_CEILING}` };
    }
    if (maxUsd > USD_CEILING) return { ok: false, error: `--max-usd above ceiling ${USD_CEILING}` };
  }

  let baseline = 0;
  if (values.has("--baseline")) {
    const n = positiveInt(values.get("--baseline"));
    if (n === null || n > BASELINE_CEILING) {
      return { ok: false, error: `--baseline must be 1..${BASELINE_CEILING}` };
    }
    baseline = n;
  }
  let limit: number | null = null;
  if (values.has("--limit")) {
    limit = positiveInt(values.get("--limit"));
    if (limit === null) return { ok: false, error: "--limit must be a positive integer" };
  }
  let repeat = 1;
  if (values.has("--repeat")) {
    const n = positiveInt(values.get("--repeat"));
    if (n === null || n > 5) return { ok: false, error: "--repeat must be 1..5" };
    repeat = n;
  }
  const list = (name: string) =>
    values.has(name)
      ? (values.get(name) as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;

  return {
    ok: true,
    options: {
      mode,
      maxCalls,
      maxUsd,
      baseline,
      limit,
      ids: list("--ids"),
      types: list("--types"),
      ignoreTrigger: flags.has("--ignore-trigger"),
      approxPrices: flags.has("--approx-prices"),
      repeat,
      outDir: values.get("--out") ?? null,
      summarize: values.get("--summarize") ?? null,
    },
  };
}

export type StopReason = "calls_cap" | "usd_cap";

/** Tavan izleyici: yeni cagri BASLAMADAN once en kotu durum maliyetiyle sorulur. */
export class CapTracker {
  calls = 0;
  spentMicros = 0;
  stoppedBy: StopReason | null = null;
  private readonly maxMicros: number | null;

  constructor(
    private readonly maxCalls: number | null,
    maxUsd: number | null,
    private readonly rule: LlmPriceRule,
  ) {
    this.maxMicros = maxUsd === null ? null : Math.round(maxUsd * 1_000_000);
  }

  /** `true`: bir sonraki cagri tavani asamaz. Reddedilirse `stoppedBy` dolar ve kosu durur. */
  allow(estimatedInputTokens: number): boolean {
    if (this.stoppedBy) return false;
    if (this.maxCalls !== null && this.calls + 1 > this.maxCalls) {
      this.stoppedBy = "calls_cap";
      return false;
    }
    if (this.maxMicros !== null) {
      const worst = costUsdMicros(
        {
          inputTokens: estimatedInputTokens,
          outputTokens: WORST_CASE_OUTPUT_TOKENS,
          thoughtTokens: 0,
        },
        this.rule,
      );
      if (this.spentMicros + worst > this.maxMicros) {
        this.stoppedBy = "usd_cap";
        return false;
      }
    }
    return true;
  }

  /** Gerceklesen HTTP denemeleri ve maliyet (saglayici sayilari; yoksa 0 token). */
  record(attempts: number, micros: number): void {
    this.calls += attempts;
    this.spentMicros += micros;
  }
}

// ---------------------------------------------------------------------------
// Vaka -> istek
// ---------------------------------------------------------------------------

/** Modele giden istegin ayni bicimi: iki kullanici mesaji + saklanan niyet + (varsa) gercekler. */
export function buildRequest(
  testCase: PilotCase,
  withFacts: boolean,
  approxPrices = false,
): InterpretRequest {
  const facts = withFacts ? factsForCase(testCase, { approxPrices }) : [];
  return {
    messages: [
      { role: "user", kind: "text", text: testCase.query },
      {
        role: "assistant",
        kind: "search",
        text: `Tamam, ${testCase.query} için aşağıda arıyorum.`,
      },
      { role: "user", kind: "text", text: testCase.question },
    ],
    currentIntent: emptyIntent(testCase.query),
    pendingQuestion: null,
    clarifyCount: 0,
    input: { kind: "text", text: testCase.question },
    ...(facts.length > 0 ? { resultFacts: facts } : {}),
  };
}

// ---------------------------------------------------------------------------
// Kayitlar
// ---------------------------------------------------------------------------

export type ReviewVerdict = "correct" | "unevidenced_claim" | "wrong" | "off_intent";
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "correct",
  "unevidenced_claim",
  "wrong",
  "off_intent",
];

export type RecordStatus =
  | "ran"
  | "skipped_not_routed"
  | "skipped_cap"
  | "provider_error"
  | "skipped_filter";

export interface CaseRecord {
  runId: string;
  id: string;
  caseId: string;
  repeatIndex: number;
  setId: string;
  category: string;
  type: PilotCase["type"];
  expect: PilotCase["expect"];
  query: string;
  question: string;
  routed: boolean;
  status: RecordStatus;
  providerCode: string | null;
  action: "answer" | "search" | "clarify" | null;
  source: "model" | "fallback" | null;
  fallbackReason: string | null;
  /** Yalniz `answer` eyleminde dolu. */
  validated: boolean | null;
  rejected: string[];
  /** Cevap eylemi dogrulanamadi ve modelsiz ozet gosterildi. */
  fallbackUsed: boolean;
  /** Kullaniciya gosterilecek metin (`message`); search/clarify'da modelin tek cumlesi. */
  shownText: string | null;
  paragraphs: { text: string; evidence: { item: string; field: string; quote: string }[] }[];
  /** Modelin HAM paragraflari (atilanlar dahil), red nedeni ve delilsiz sayilarla. Kullaniciya gitmez. */
  rawParagraphs: {
    text: string;
    evidence: { item: string; field: string; quote: string }[];
    problem: string | null;
    unevidencedNumbers: string[];
  }[];
  latencyMs: number | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsdMicros: number;
  autoFlags: string[];
  review: { verdict: ReviewVerdict | null; notes: string };
}

/** Kati: cikti metninde eslesir VE gercek metinlerinde eslesmezse bayrak (kanitsiz iddia). */
export function forbiddenHits(
  text: string,
  facts: readonly ResultFact[],
  patterns: readonly string[],
): string[] {
  const factText = facts
    .map((f) => [f.title, f.brand, f.store].filter(Boolean).join(" "))
    .join(" ");
  const hits: string[] = [];
  for (const source of patterns) {
    const re = new RegExp(source, "iu");
    if (re.test(text) && !re.test(factText)) hits.push(source);
  }
  return hits;
}

export function autoFlags(
  testCase: PilotCase,
  record: Pick<CaseRecord, "status" | "action" | "validated" | "shownText" | "routed">,
  facts: readonly ResultFact[],
): string[] {
  const flags: string[] = [];
  const shouldRoute = testCase.expect !== "not_routed";
  if (record.routed !== shouldRoute) flags.push("trigger_mismatch");
  if (record.status !== "ran") return flags;
  if (record.shownText) {
    for (const hit of forbiddenHits(record.shownText, facts, testCase.forbiddenPatterns)) {
      flags.push(`forbidden_pattern:${hit}`);
    }
  }
  if (testCase.expect === "should_answer" && !(record.action === "answer" && record.validated)) {
    flags.push("should_answer_not_validated");
  }
  if (
    testCase.expect === "should_decline_or_fallback" &&
    record.action === "answer" &&
    record.validated
  ) {
    flags.push("decline_case_answered_review");
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Kosu
// ---------------------------------------------------------------------------

export interface RunDeps {
  interpreter: ChatInterpreter;
  options: Pick<PilotOptions, "ignoreTrigger" | "baseline" | "repeat"> & {
    approxPrices?: boolean;
  };
  tracker: CapTracker;
  rule: LlmPriceRule;
  /** `performance.now()` benzeri; testlerde enjekte edilir. */
  now: () => number;
  runId: string;
}

export interface BaselineRecord {
  caseId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsdMicros: number;
  action: string | null;
}

export interface RunResult {
  records: CaseRecord[];
  baselines: BaselineRecord[];
  stoppedBy: StopReason | null;
}

function requestChars(request: InterpretRequest): number {
  // Sistem talimati + sema modelde de girdi sayilir; kaba ust tahmin icin istek JSON'u + sabit pay.
  return JSON.stringify(request).length + 14_000;
}

function baseRecord(
  runId: string,
  testCase: PilotCase,
  repeatIndex: number,
  routed: boolean,
): CaseRecord {
  return {
    runId,
    id: repeatIndex === 0 ? testCase.id : `${testCase.id}#${repeatIndex + 1}`,
    caseId: testCase.id,
    repeatIndex,
    setId: testCase.setId,
    category: testCase.category,
    type: testCase.type,
    expect: testCase.expect,
    query: testCase.query,
    question: testCase.question,
    routed,
    status: "ran",
    providerCode: null,
    action: null,
    source: null,
    fallbackReason: null,
    validated: null,
    rejected: [],
    fallbackUsed: false,
    shownText: null,
    paragraphs: [],
    rawParagraphs: [],
    latencyMs: null,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    costUsdMicros: 0,
    autoFlags: [],
    review: { verdict: null, notes: "" },
  };
}

async function runOne(
  deps: RunDeps,
  request: InterpretRequest,
): Promise<{
  outcome: Awaited<ReturnType<typeof interpretTurn>>;
  /** Modelin ham `answer` nesnesi (yakalanamadiysa undefined). */
  rawAnswer: unknown;
  latencyMs: number;
  usage: TokenUsage & { attempts: number };
  micros: number;
}> {
  const start = deps.now();
  let rawAnswer: unknown;
  const capturing: ChatInterpreter = {
    modelVersion: deps.interpreter.modelVersion,
    async interpret(req, options) {
      const result = await deps.interpreter.interpret(req, options);
      const value = result.value as { answer?: unknown } | null;
      rawAnswer = value && typeof value === "object" ? value.answer : undefined;
      return result;
    },
  };
  const outcome = await interpretTurn(capturing, request);
  const latencyMs = Math.round(deps.now() - start);
  const usage = sumCalls(outcome.calls);
  const micros = costUsdMicros(usage, deps.rule);
  deps.tracker.record(usage.attempts, micros);
  return { outcome, rawAnswer, latencyMs, usage, micros };
}

/** Vakalari sirayla kosar (paralel yok: gecikme olcumu ve tavan kesinligi icin). */
export async function runPilot(cases: readonly PilotCase[], deps: RunDeps): Promise<RunResult> {
  const records: CaseRecord[] = [];
  const baselines: BaselineRecord[] = [];
  let baselineLeft = deps.options.baseline;

  for (let repeat = 0; repeat < deps.options.repeat; repeat++) {
    for (const testCase of cases) {
      const routed = looksLikeResultQuestion(testCase.question);
      const record = baseRecord(deps.runId, testCase, repeat, routed);
      const facts = factsForCase(testCase, { approxPrices: deps.options.approxPrices });
      const callModel = deps.options.ignoreTrigger || routed;
      if (!callModel) {
        record.status = "skipped_not_routed";
        record.autoFlags = autoFlags(testCase, record, facts);
        records.push(record);
        continue;
      }
      const request = buildRequest(testCase, true, deps.options.approxPrices);
      if (!deps.tracker.allow(estimateTokens(requestChars(request)))) {
        record.status = "skipped_cap";
        records.push(record);
        continue;
      }
      const { outcome, rawAnswer, latencyMs, usage, micros } = await runOne(deps, request);
      record.latencyMs = latencyMs;
      record.attempts = usage.attempts;
      record.inputTokens = usage.inputTokens;
      record.outputTokens = usage.outputTokens;
      record.thoughtTokens = usage.thoughtTokens;
      record.costUsdMicros = micros;
      if (outcome.kind === "provider_error") {
        record.status = "provider_error";
        record.providerCode = outcome.code;
      } else {
        const turn = outcome.turn;
        record.action = turn.action;
        record.source = outcome.source;
        record.fallbackReason = outcome.fallbackReason;
        record.shownText = turn.message ?? null;
        if (turn.action === "answer") {
          const answer = turn.answer as {
            paragraphs?: CaseRecord["paragraphs"];
            validated?: boolean;
            rejected?: string[];
          };
          record.validated = answer.validated === true;
          record.rejected = answer.rejected ?? [];
          record.paragraphs = answer.paragraphs ?? [];
          const inspected: ParagraphInspection[] | null = inspectAnswer(rawAnswer, facts, {
            question: testCase.question,
          });
          record.rawParagraphs = (inspected ?? []).map((item) => ({
            text: item.paragraph.text,
            evidence: item.paragraph.evidence,
            problem: item.problem,
            unevidencedNumbers: item.unevidencedNumbers,
          }));
          record.fallbackUsed = !record.validated;
        }
      }
      record.autoFlags = autoFlags(testCase, record, facts);
      records.push(record);

      // Taban olcumu: ayni vaka, gercekler OLMADAN (normal sohbet turu). Yalniz ilk tekrar.
      if (baselineLeft > 0 && repeat === 0 && routed) {
        const baseReq = buildRequest(testCase, false);
        if (deps.tracker.allow(estimateTokens(requestChars(baseReq)))) {
          const base = await runOne(deps, baseReq);
          baselines.push({
            caseId: testCase.id,
            latencyMs: base.latencyMs,
            inputTokens: base.usage.inputTokens,
            outputTokens: base.usage.outputTokens,
            thoughtTokens: base.usage.thoughtTokens,
            costUsdMicros: base.micros,
            action: base.outcome.kind === "turn" ? base.outcome.turn.action : null,
          });
          baselineLeft--;
        }
      }
      // Tavana takilinca `allow` kalici olarak reddeder; kalan vakalar `skipped_cap` yazilir.
    }
  }
  return { records, baselines, stoppedBy: deps.tracker.stoppedBy };
}

// ---------------------------------------------------------------------------
// Toplu olcumler
// ---------------------------------------------------------------------------

/** En yakin sira (nearest-rank) yuzdeligi; bos dizi `null`. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

export interface Aggregates {
  totalRecords: number;
  ran: number;
  skippedNotRouted: number;
  skippedCap: number;
  providerErrors: number;
  actions: Record<string, number>;
  answerActions: number;
  validated: number;
  /** validated / answer eylemi (cikis olcutu: >= %95). */
  validRate: number | null;
  /** should_answer vakalarinin dogrulanmis cevap orani. */
  shouldAnswerValidRate: number | null;
  /** Cevap eylemi dogrulanamayip modelsiz ozete dusen oran. */
  fallbackRate: number | null;
  rejectionReasons: Record<string, number>;
  fallbackReasons: Record<string, number>;
  flagCounts: Record<string, number>;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  baselineCount: number;
  baselineLatencyP50Ms: number | null;
  baselineLatencyP95Ms: number | null;
  /** Cikis olcutu: <= +1000 ms. */
  latencyDeltaP95Ms: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgThoughtTokens: number | null;
  totalCostUsd: number;
  /** Ran basina (her cevap turu tek cagri). */
  costPerTurnUsd: number | null;
  /** Dogrulanmis cevap basina toplam maliyet (basarisiz cagrilar dahil). */
  costPerValidatedAnswerUsd: number | null;
  baselineCostPerTurnUsd: number | null;
  incrementalCostPerTurnUsd: number | null;
  projections: { answersPerDay: number; dailyUsd: number; monthlyUsd: number }[];
  stoppedBy: StopReason | null;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};

export const PROJECTION_VOLUMES = [1_000, 10_000] as const;

export function aggregate(
  records: readonly CaseRecord[],
  baselines: readonly BaselineRecord[],
  stoppedBy: StopReason | null,
): Aggregates {
  const ran = records.filter((r) => r.status === "ran");
  const actions: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};
  const fallbackReasons: Record<string, number> = {};
  const flagCounts: Record<string, number> = {};
  for (const r of ran) {
    bump(actions, r.action ?? "none");
    for (const reason of r.rejected) bump(rejectionReasons, reason);
    if (r.fallbackReason) bump(fallbackReasons, r.fallbackReason);
  }
  for (const r of records)
    for (const flag of r.autoFlags) bump(flagCounts, flag.split(":")[0] as string);

  const answers = ran.filter((r) => r.action === "answer");
  const validated = answers.filter((r) => r.validated).length;
  const shouldAnswer = ran.filter((r) => r.expect === "should_answer");
  const shouldAnswerOk = shouldAnswer.filter((r) => r.action === "answer" && r.validated).length;
  const latencies = ran.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]));
  const baseLatencies = baselines.map((b) => b.latencyMs);
  const p95 = percentile(latencies, 95);
  const baseP95 = percentile(baseLatencies, 95);

  const calledRecords = ran.filter((r) => r.attempts > 0);
  const totalMicros =
    records.reduce((sum, r) => sum + r.costUsdMicros, 0) +
    baselines.reduce((sum, b) => sum + b.costUsdMicros, 0);
  const answerMicros = records.reduce((sum, r) => sum + r.costUsdMicros, 0);
  const costPerTurnMicros = ratio(
    calledRecords.reduce((s, r) => s + r.costUsdMicros, 0),
    calledRecords.length,
  );
  const baseCostMicros = ratio(
    baselines.reduce((s, b) => s + b.costUsdMicros, 0),
    baselines.length,
  );
  const perTurnUsd = costPerTurnMicros === null ? null : usdFromMicros(costPerTurnMicros);

  return {
    totalRecords: records.length,
    ran: ran.length,
    skippedNotRouted: records.filter((r) => r.status === "skipped_not_routed").length,
    skippedCap: records.filter((r) => r.status === "skipped_cap").length,
    providerErrors: records.filter((r) => r.status === "provider_error").length,
    actions,
    answerActions: answers.length,
    validated,
    validRate: ratio(validated, answers.length),
    shouldAnswerValidRate: ratio(shouldAnswerOk, shouldAnswer.length),
    fallbackRate: ratio(answers.length - validated, answers.length),
    rejectionReasons,
    fallbackReasons,
    flagCounts,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: p95,
    baselineCount: baselines.length,
    baselineLatencyP50Ms: percentile(baseLatencies, 50),
    baselineLatencyP95Ms: baseP95,
    latencyDeltaP95Ms: p95 !== null && baseP95 !== null ? p95 - baseP95 : null,
    avgInputTokens: mean(calledRecords.map((r) => r.inputTokens)),
    avgOutputTokens: mean(calledRecords.map((r) => r.outputTokens)),
    avgThoughtTokens: mean(calledRecords.map((r) => r.thoughtTokens)),
    totalCostUsd: usdFromMicros(totalMicros),
    costPerTurnUsd: perTurnUsd,
    costPerValidatedAnswerUsd: ratio(usdFromMicros(answerMicros), validated),
    baselineCostPerTurnUsd: baseCostMicros === null ? null : usdFromMicros(baseCostMicros),
    incrementalCostPerTurnUsd:
      costPerTurnMicros !== null && baseCostMicros !== null
        ? usdFromMicros(costPerTurnMicros - baseCostMicros)
        : null,
    projections: PROJECTION_VOLUMES.map((answersPerDay) => ({
      answersPerDay,
      dailyUsd: (perTurnUsd ?? 0) * answersPerDay,
      monthlyUsd: (perTurnUsd ?? 0) * answersPerDay * 30,
    })),
    stoppedBy,
  };
}

// ---------------------------------------------------------------------------
// Insan denetimi
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  reviewedAnswers: number;
  pending: number;
  verdicts: Record<ReviewVerdict, number>;
  /** Kritik = delilsiz iddia ya da yanlis. Cikis olcutu: 0. */
  critical: number;
  correctRate: number | null;
  /** Cikis olcutu: >= 100 denetlenen cevap VE critical == 0. */
  meetsAuditBar: boolean;
}

/** Denetcinin doldurdugu kayitlardan ozet. Yalniz DOGRULANMIS cevap eylemleri denetlenir. */
export function summarizeReviews(records: readonly CaseRecord[]): ReviewSummary {
  const shown = records.filter((r) => r.status === "ran" && r.action === "answer" && r.validated);
  const verdicts: Record<ReviewVerdict, number> = {
    correct: 0,
    unevidenced_claim: 0,
    wrong: 0,
    off_intent: 0,
  };
  let pending = 0;
  for (const r of shown) {
    const v = r.review.verdict;
    if (v === null) pending++;
    else if (REVIEW_VERDICTS.includes(v)) verdicts[v]++;
  }
  const reviewed = shown.length - pending;
  const critical = verdicts.unevidenced_claim + verdicts.wrong;
  return {
    reviewedAnswers: reviewed,
    pending,
    verdicts,
    critical,
    correctRate: ratio(verdicts.correct, reviewed),
    meetsAuditBar: reviewed >= 100 && critical === 0,
  };
}

// ---------------------------------------------------------------------------
// Cikti
// ---------------------------------------------------------------------------

export interface RunMeta {
  runId: string;
  mode: "dry" | "real";
  model: string;
  startedAt: string;
  caps: { maxCalls: number | null; maxUsd: number | null };
  priceRuleId: string;
  note: string;
}

export interface AuditReport {
  meta: RunMeta;
  aggregates: Aggregates;
  records: CaseRecord[];
  baselines: BaselineRecord[];
}

const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null) => (v === null ? "-" : `${Math.round(v)} ms`);
const usd = (v: number | null, digits = 5) => (v === null ? "-" : `$${v.toFixed(digits)}`);
const num = (v: number | null) => (v === null ? "-" : v.toFixed(0));
const cell = (text: string | null) =>
  (text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";

export function renderMarkdown(report: AuditReport): string {
  const { meta, aggregates: a, records } = report;
  const lines: string[] = [];
  lines.push(`# Sohbet sonuç cevabı pilotu: denetim sayfası (${meta.runId})`);
  lines.push("");
  lines.push(
    `Mod: **${meta.mode === "dry" ? "KURU KOŞU (sahte model; sayılar karar için KULLANILMAZ)" : "GERÇEK"}** · model: ${meta.model} · başlangıç: ${meta.startedAt}`,
  );
  lines.push(
    `Tavan: çağrı ${meta.caps.maxCalls ?? "yok"}, USD ${meta.caps.maxUsd ?? "yok"} · fiyat kuralı: ${meta.priceRuleId}${a.stoppedBy ? ` · **TAVANA TAKILDI (${a.stoppedBy})**` : ""}`,
  );
  lines.push("");
  lines.push("## Toplu ölçümler");
  lines.push("");
  lines.push("| Ölçüm | Değer | Çıkış ölçütü |");
  lines.push("|---|---|---|");
  lines.push(
    `| Doğrulanan cevap oranı (doğrulanan / cevap eylemi) | ${pct(a.validRate)} (${a.validated}/${a.answerActions}) | >= %95 |`,
  );
  lines.push(
    `| should_answer vakalarında doğrulanmış cevap | ${pct(a.shouldAnswerValidRate)} | bilgi |`,
  );
  lines.push(`| Yedek (modelsiz özet) oranı | ${pct(a.fallbackRate)} | bilgi |`);
  lines.push(`| Gecikme p50 / p95 | ${ms(a.latencyP50Ms)} / ${ms(a.latencyP95Ms)} | bilgi |`);
  lines.push(
    `| Taban (gerçeksiz tur) p50 / p95 (n=${a.baselineCount}) | ${ms(a.baselineLatencyP50Ms)} / ${ms(a.baselineLatencyP95Ms)} | bilgi |`,
  );
  lines.push(
    `| p95 gecikme farkı (cevap turu - taban) | ${ms(a.latencyDeltaP95Ms)} | <= +1000 ms |`,
  );
  lines.push(
    `| Ortalama token (girdi / çıktı / düşünme) | ${num(a.avgInputTokens)} / ${num(a.avgOutputTokens)} / ${num(a.avgThoughtTokens)} | ölçülür |`,
  );
  lines.push(`| Toplam maliyet | ${usd(a.totalCostUsd)} | bilgi |`);
  lines.push(`| Tur başına maliyet (cevap turu) | ${usd(a.costPerTurnUsd)} | ölçülür |`);
  lines.push(
    `| Doğrulanmış cevap başına maliyet | ${usd(a.costPerValidatedAnswerUsd)} | ölçülür |`,
  );
  lines.push(
    `| Taban tur maliyeti / artış | ${usd(a.baselineCostPerTurnUsd)} / ${usd(a.incrementalCostPerTurnUsd)} | bilgi |`,
  );
  for (const p of a.projections) {
    lines.push(
      `| Tahmin: ${p.answersPerDay.toLocaleString("en-US")} cevap/gün | ${usd(p.dailyUsd, 2)}/gün, ${usd(p.monthlyUsd, 2)}/ay | bilgi |`,
    );
  }
  lines.push("");
  lines.push(
    `Kayıt: ${a.totalRecords} (koşulan ${a.ran}, yönlendirilmeyen ${a.skippedNotRouted}, tavan ${a.skippedCap}, sağlayıcı hatası ${a.providerErrors}).`,
  );
  lines.push(
    `Eylemler: ${JSON.stringify(a.actions)} · red nedenleri: ${JSON.stringify(a.rejectionReasons)}`,
  );
  lines.push(`Otomatik bayraklar: ${JSON.stringify(a.flagCounts)}`);
  lines.push("");
  lines.push("## Denetçi için");
  lines.push("");
  lines.push(
    "Her doğrulanmış cevap için JSON dosyasında `review.verdict` alanını doldurun: `correct`, `unevidenced_claim`, `wrong`, `off_intent`. Sonra `--summarize <audit.json>` ile özet alın. Kritik = `unevidenced_claim` + `wrong` (hedef 0; en az 100 denetlenen cevap).",
  );
  lines.push("");
  lines.push("## Vakalar");
  lines.push("");
  for (const r of records) {
    lines.push(`### ${r.id} · ${r.type} · beklenti: ${r.expect}`);
    lines.push("");
    lines.push(`- Sorgu: ${cell(r.query)} · soru: ${cell(r.question)}`);
    lines.push(
      `- Durum: ${r.status}${r.providerCode ? ` (${r.providerCode})` : ""} · eylem: ${r.action ?? "-"} · kaynak: ${r.source ?? "-"} · doğrulandı: ${r.validated === null ? "-" : r.validated} · yedek: ${r.fallbackUsed ? "evet" : "hayır"}${r.rejected.length ? ` · red: ${r.rejected.join(", ")}` : ""}`,
    );
    lines.push(
      `- Gecikme: ${ms(r.latencyMs)} · token g/ç/d: ${r.inputTokens}/${r.outputTokens}/${r.thoughtTokens} · maliyet: ${usd(usdFromMicros(r.costUsdMicros), 6)}`,
    );
    if (r.autoFlags.length)
      lines.push(`- Otomatik bayrak: ${r.autoFlags.map((x) => `\`${x}\``).join(", ")}`);
    lines.push(`- Gösterilen metin: ${cell(r.shownText)}`);
    for (const [i, p] of r.paragraphs.entries()) {
      lines.push(
        `  - P${i + 1}: ${cell(p.text)} · delil: ${p.evidence.map((e) => `${e.item}.${e.field}="${cell(e.quote)}"`).join("; ") || "-"}`,
      );
    }
    for (const [i, p] of r.rawParagraphs.entries()) {
      lines.push(
        `  - HAM P${i + 1} [${p.problem ?? "geçti"}${p.unevidencedNumbers.length ? ` sayı: ${p.unevidencedNumbers.join(",")}` : ""}]: ${cell(p.text)} · delil: ${p.evidence.map((e) => `${e.item}.${e.field}="${cell(e.quote)}"`).join("; ") || "-"}`,
      );
    }
    lines.push(
      "- Denetçi kararı: [ ] doğru  [ ] delilsiz iddia  [ ] yanlış  [ ] niyet dışı  · not: ",
    );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Gercek kosu maliyet tahmini (kuru kosu girdi boyutlarindan)
// ---------------------------------------------------------------------------

export interface CostEstimateAssumptions {
  /** Cevap turu basina varsayilan cikti token'i (3 paragraf + delil JSON'u). */
  outputTokens: number;
  thoughtTokens: number;
}

export interface CostEstimate {
  calls: number;
  inputTokens: number;
  costUsd: number;
}

/** Girdi: kuru kosu kayitlarindaki tahmini girdi token'lari; cikti/dusunme varsayimdir. */
export function estimateRunCost(
  inputTokensPerCall: readonly number[],
  assumptions: CostEstimateAssumptions,
  rule: LlmPriceRule,
): CostEstimate {
  let micros = 0;
  let input = 0;
  for (const tokens of inputTokensPerCall) {
    input += tokens;
    micros += costUsdMicros(
      {
        inputTokens: tokens,
        outputTokens: assumptions.outputTokens,
        thoughtTokens: assumptions.thoughtTokens,
      },
      rule,
    );
  }
  return { calls: inputTokensPerCall.length, inputTokens: input, costUsd: usdFromMicros(micros) };
}
