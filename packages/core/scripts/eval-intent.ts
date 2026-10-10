/**
 * Niyet degerlendirmesi (Faz 1A). Deterministik, ag/DB/model yok.
 *
 *   node scripts/eval-intent.ts [--json cikti.json] [--record]
 * `--record` yoksa veritabanina yazilmaz; varsa yalnizca yerel DATABASE_URL.
 *
 * Basarisiz vaka varsa cikis kodu 1.
 */
import { writeFileSync } from "node:fs";
import { runIntentEval } from "../src/eval/intent-eval.ts";
import { intentRecord } from "../src/eval/record-adapters.ts";
import { codeRef, guardRecordFlag, recordOrExit } from "./lib/eval-record.ts";

const record = guardRecordFlag();
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
  await recordOrExit(intentRecord(rows, summary, `rules@${codeRef()}`));
}
process.exit(rows.some((r) => r.failures.length > 0) ? 1 : 0);
