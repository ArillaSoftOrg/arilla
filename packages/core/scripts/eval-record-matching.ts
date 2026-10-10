/**
 * Eslestirme degerlendirmesini kaydeder (Faz 1A-4). Python calistirilmaz; once
 *
 *   python -m resolve.eval_offline --json > out.json
 *   node scripts/eval-record-matching.ts out.json [--record]
 *
 * `--record` yoksa hicbir sey yazilmaz. Yalnizca yerel DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { type MatchingReportJson, matchingRecord } from "../src/eval/record-adapters.ts";
import { guardRecordFlag, recordOrExit } from "./lib/eval-record.ts";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("kullanim: eval-record-matching.ts out.json [--record]");
  process.exit(2);
}
const record = guardRecordFlag();
const report = JSON.parse(readFileSync(file, "utf8")) as MatchingReportJson;
const pairs = JSON.parse(
  readFileSync(
    new URL("../../../services/ingest/tests/fixtures/matching/pairs.json", import.meta.url),
    "utf8",
  ),
);
const verified = (pairs.should_match?.length ?? 0) + (pairs.should_not_match?.length ?? 0);
const t = report.thresholds;
const version = t ? `thresholds-q${t.queue}-a${t.auto}` : "thresholds-unknown";
console.log(`eslestirme: ${verified} cift, ${report.errors.length} hata`);
if (record) {
  await recordOrExit(matchingRecord(report, pairs, verified, version));
} else {
  console.log("--record verilmedi; hicbir sey yazilmadi.");
}
