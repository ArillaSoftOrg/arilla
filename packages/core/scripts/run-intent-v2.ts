/**
 * Faz 1B: dev setinde tek IntentV2 model kosusu (docs/decisions/0171 §13).
 * UCRETLIDIR; acik onay ve iki tavan zorunludur. Veritabanina dokunmaz.
 *
 *   INTENT_V2_PAID_RUN=1 GEMINI_API_KEY=... pnpm --filter @arilla/core run:intent-v2 \
 *     --max-calls 220 --max-usd 1 --out <dizin>
 *
 * Cikti: <dizin>/predictions.json ({id: ham cikti}) ve <dizin>/run-report.json.
 * Puanlama: pnpm eval:intent-v2 --predictions <dizin>/predictions.json
 *
 * Yalnizca dev seti; holdout bu betikle kosulmaz (Faz 3, bir kez).
 * Konsola yalnizca sayilar yazilir: anahtar, istem, sorgu ya da yanit yok.
 * Cikis kodu: 0 tamam, 1 hata, 2 reddedildi (istek gonderilmedi).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentV2Dataset } from "../src/eval/intent-v2-eval.ts";
import { runIntentV2Predictions } from "../src/eval/intent-v2-run.ts";
import { getLlmClient } from "../src/llm/gemini.ts";

const ATTEMPTS_PER_CASE = 2;

function refuse(reason: string): never {
  process.stdout.write(`result: refused (${reason}; no request was sent)\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};

if (process.env.INTENT_V2_PAID_RUN !== "1") refuse("missing_opt_in INTENT_V2_PAID_RUN=1");
if (
  process.env.DEPLOY_ENV === "production" ||
  process.env.VERCEL_ENV === "production" ||
  process.env.NODE_ENV === "production"
) {
  refuse("production_env");
}
if (args.includes("--holdout-final")) refuse("holdout_not_allowed");
const maxCalls = Number(value("--max-calls"));
const maxUsd = Number(value("--max-usd"));
const out = value("--out");
if (!Number.isInteger(maxCalls) || maxCalls <= 0) refuse("missing --max-calls");
if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 5) refuse("missing or >5 --max-usd");
if (!out) refuse("missing --out");
if (!process.env.GEMINI_API_KEY?.trim()) refuse("missing_api_key");

const dataset = JSON.parse(
  readFileSync(new URL("../src/eval/datasets/intent-v2.dev.json", import.meta.url), "utf8"),
) as IntentV2Dataset;

const client = getLlmClient(process.env, { maxAttempts: ATTEMPTS_PER_CASE, timeoutMs: 15_000 });

runIntentV2Predictions(dataset.cases, client, {
  maxCalls,
  maxUsdMicros: Math.round(maxUsd * 1_000_000),
  attemptsPerCase: ATTEMPTS_PER_CASE,
}).then(
  ({ predictions, report }) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "predictions.json"), `${JSON.stringify(predictions, null, 2)}\n`);
    writeFileSync(join(out, "run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const lines = [
      `model: ${report.model}`,
      `contract: ${report.contractHash.slice(0, 12)}`,
      `cases: ${report.cases} ok: ${report.ok} skipped_budget: ${report.skippedBudget}`,
      `errors: ${JSON.stringify(report.errors)}`,
      `http_attempts: ${report.httpAttempts}/${maxCalls}`,
      `tokens: in ${report.inputTokens} out ${report.outputTokens}`,
      `usd_estimate: ${(report.usdMicros / 1e6).toFixed(4)} / ${maxUsd} (${report.priceRuleId})`,
      `usd_per_1000: ${report.usdMicrosPer1000 === null ? "n/a" : (report.usdMicrosPer1000 / 1e6).toFixed(4)}`,
      `latency_ms: p50 ${report.latencyP50Ms ?? "n/a"} p95 ${report.latencyP95Ms ?? "n/a"}`,
    ];
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.exit(0);
  },
  (error: unknown) => {
    process.stdout.write(`result: FAIL (${error instanceof Error ? error.name : "error"})\n`);
    process.exit(1);
  },
);
