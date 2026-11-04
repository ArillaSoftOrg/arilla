/**
 * Faz 1B olcum kosucusu (docs/decisions/0171 §13): dev setindeki her sorgu icin
 * TEK IntentV2 model cagrisi, ham cikti `{id: raw}` olarak doner; puanlama
 * `scripts/eval-intent-v2.ts --predictions` ile ayri yapilir.
 *
 * Istek yolunda DEGILDIR; veritabanina dokunmaz (`gemini:smoke` deseni,
 * karar 0059). Kullanim ve tahmini maliyet rapora yazilir.
 *
 * Kati tavanlar (onceden kontrol edilir, asilamaz):
 * - `maxCalls`: yeniden denemeler dahil HTTP denemesi. Bir vaka ancak en kotu
 *   durumda bile (istemcinin tum denemeleri) tavanin altinda kalacaksa baslar.
 * - `maxUsdMicros`: liste fiyatiyla tahmini USD. Bir vaka ancak harcanan +
 *   en kotu durum vaka maliyeti tavanin altinda kalacaksa baslar.
 * Tavana gelince kalan vakalar `skipped_budget` olur; hicbiri sessizce atlanmaz.
 */

import {
  buildIntentV2Input,
  buildIntentV2JsonSchema,
  INTENT_V2_INSTRUCTIONS,
  intentV2ContractHash,
} from "../intent/contract.ts";
import type { LlmCall, LlmClient } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import { findLlmPriceRule } from "../llm/pricing.ts";
import type { IntentV2Case } from "./intent-v2-eval.ts";

export const RUN_MAX_OUTPUT_TOKENS = 512;

export interface RunLimits {
  maxCalls: number;
  maxUsdMicros: number;
  /** Istemcinin vaka basina en fazla HTTP denemesi (tavan hesabi icin). */
  attemptsPerCase: number;
}

export type CaseStatus = "ok" | "skipped_budget" | `error:${string}`;

export interface CaseRecord {
  id: string;
  status: CaseStatus;
  attempts: number;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  usdMicros: number;
}

export interface RunReport {
  model: string;
  contractHash: string;
  priceRuleId: string;
  limits: RunLimits;
  cases: number;
  ok: number;
  errors: Record<string, number>;
  skippedBudget: number;
  httpAttempts: number;
  inputTokens: number;
  outputTokens: number;
  usdMicros: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  usdMicrosPer1000: number | null;
  records: CaseRecord[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}

export async function runIntentV2Predictions(
  cases: readonly IntentV2Case[],
  client: LlmClient,
  limits: RunLimits,
  options: { now?: () => number; at?: Date } = {},
): Promise<{ predictions: Record<string, unknown>; report: RunReport }> {
  if (!(limits.maxCalls > 0) || !(limits.maxUsdMicros > 0) || !(limits.attemptsPerCase >= 1)) {
    throw new Error("intent-v2-run: tavanlar pozitif olmali");
  }
  const rule = findLlmPriceRule(client.modelVersion, options.at ?? new Date());
  if (!rule)
    throw new Error("intent-v2-run: model icin fiyat kurali yok; maliyet tavani uygulanamaz");
  /** Liste fiyatiyla USD-mikro (yukari yuvarlanir). */
  const usd = (input: number, output: number) =>
    Math.ceil(
      (input * rule.inputUsdMicrosPerMTok + output * rule.outputUsdMicrosPerMTok) / 1_000_000,
    );

  const now = options.now ?? (() => performance.now());
  const schema = buildIntentV2JsonSchema();
  const predictions: Record<string, unknown> = {};
  const records: CaseRecord[] = [];
  let attempts = 0;
  let spent = 0;
  // En kotu vaka girdisi: gozlenen en buyuk girdi; ilk vakada karakter sayisi
  // (token sayisindan her zaman buyuk ya da esit, ihtiyatli).
  let worstInput = 0;

  for (const testCase of cases) {
    const input = buildIntentV2Input(testCase.q);
    const inputBound = Math.max(worstInput, INTENT_V2_INSTRUCTIONS.length + input.length);
    const worstAttempt = usd(inputBound, RUN_MAX_OUTPUT_TOKENS);
    const worstCase = limits.attemptsPerCase * worstAttempt;
    if (
      attempts + limits.attemptsPerCase > limits.maxCalls ||
      spent + worstCase > limits.maxUsdMicros
    ) {
      predictions[testCase.id] = null;
      records.push({
        id: testCase.id,
        status: "skipped_budget",
        attempts: 0,
        latencyMs: null,
        inputTokens: 0,
        outputTokens: 0,
        usdMicros: 0,
      });
      continue;
    }

    const record: CaseRecord = {
      id: testCase.id,
      status: "ok",
      attempts: 0,
      latencyMs: null,
      inputTokens: 0,
      outputTokens: 0,
      usdMicros: 0,
    };
    const onCall = (call: LlmCall) => {
      record.attempts += 1;
      attempts += 1;
      const inTok = call.usage?.inputTokens ?? 0;
      const outTok = (call.usage?.outputTokens ?? 0) + (call.usage?.thoughtTokens ?? 0);
      record.inputTokens += inTok;
      record.outputTokens += outTok;
      // Kullanim okunamayan deneme en kotu durumla sayilir (0 sayilmaz).
      const cost = call.usage === null || inTok + outTok === 0 ? worstAttempt : usd(inTok, outTok);
      record.usdMicros += cost;
      spent += cost;
      if (inTok > worstInput) worstInput = inTok;
    };
    const started = now();
    try {
      const result = await client.generateJson(
        {
          systemInstruction: INTENT_V2_INSTRUCTIONS,
          input,
          schema,
          maxOutputTokens: RUN_MAX_OUTPUT_TOKENS,
        },
        { onCall },
      );
      predictions[testCase.id] = result.value;
    } catch (error) {
      predictions[testCase.id] = null;
      record.status = `error:${error instanceof LlmError ? error.code : "unexpected"}`;
    }
    record.latencyMs = Math.round(now() - started);
    records.push(record);
  }

  const latencies = records
    .filter((r) => r.status === "ok" && r.latencyMs !== null)
    .map((r) => r.latencyMs as number)
    .sort((a, b) => a - b);
  const errors: Record<string, number> = {};
  for (const r of records) {
    if (r.status.startsWith("error:"))
      errors[r.status.slice(6)] = (errors[r.status.slice(6)] ?? 0) + 1;
  }
  const ok = records.filter((r) => r.status === "ok").length;
  const report: RunReport = {
    model: client.modelVersion,
    contractHash: intentV2ContractHash(),
    priceRuleId: rule.id,
    limits,
    cases: cases.length,
    ok,
    errors,
    skippedBudget: records.filter((r) => r.status === "skipped_budget").length,
    httpAttempts: attempts,
    inputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
    usdMicros: spent,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    usdMicrosPer1000: ok > 0 ? Math.ceil((spent / ok) * 1000) : null,
    records,
  };
  return { predictions, report };
}
