/**
 * Niyet degerlendirmesi (Faz 1A). Deterministik, ag/DB/model yok.
 *
 *   node scripts/eval-intent.ts [--json cikti.json] [--record]
 *
 * `--record` verilmezse veritabanina dokunulmaz. `--record` yalnizca yerel
 * DATABASE_URL ile ai_eval_* tablolarina yazar (karar 0098).
 *
 * Basarisiz vaka varsa cikis kodu 1.
 */
import { writeFileSync } from "node:fs";
import { createDatabase } from "@arilla/db";
import { INTENT_CASES, runIntentEval } from "../src/eval/intent-eval.ts";
import { intentStoredMetrics } from "../src/eval/metric-keys.ts";
import { EVAL_ALGORITHM_VERSIONS, recordEvalResult } from "../src/eval/record.ts";
import { intentCases } from "../src/eval/record-cases.ts";
import {
  gitShortRef,
  printRecordOutcome,
  requireLocalDatabaseUrl,
  wantsRecord,
} from "./lib-eval-record.ts";

const record = wantsRecord();
const recordUrl = record ? requireLocalDatabaseUrl() : "";
const started = performance.now();
const { rows, summary } = runIntentEval();
for (const row of rows.filter((r) => r.failures.length > 0)) {
  console.log(`BASARISIZ ${row.query}: ${row.failures.join("; ")}`);
}
console.log(
  `vaka ${summary.cases} | tam gecen ${(summary.exactPassRate * 100).toFixed(1)}% | action macro-F1 ${summary.action.macroF1.toFixed(3)} | accuracy ${summary.action.accuracy.toFixed(3)}`,
);
const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
  writeFileSync(process.argv[jsonIndex + 1] as string, JSON.stringify({ rows, summary }, null, 2));
}
if (record) {
  const db = createDatabase(recordUrl);
  const outcome = await recordEvalResult(db, {
    component: "gemini_intent",
    dataset: "intent",
    datasetVersion: "golden",
    items: INTENT_CASES,
    verifiedCount: INTENT_CASES.length,
    algorithmVersion: EVAL_ALGORITHM_VERSIONS.gemini_intent,
    metrics: intentStoredMetrics(summary),
    cases: intentCases(rows),
    durationMs: performance.now() - started,
    ...(gitShortRef() ? { codeRef: gitShortRef() as string } : {}),
  });
  printRecordOutcome(outcome);
  await db.$client.end();
}
process.exit(rows.some((r) => r.failures.length > 0) ? 1 : 0);
