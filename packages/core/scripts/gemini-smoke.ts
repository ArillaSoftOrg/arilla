/**
 * Gemini baglanti dumani - sabit sentetik sorgu, tek HTTP denemesi
 * (docs/decisions/0059, docs/ops.md). Veritabanina dokunmaz.
 *
 *   GEMINI_SMOKE=1 pnpm gemini:smoke
 *
 * Cikis kodu: 0 basarili, 1 basarisiz, 2 reddedildi (istek gonderilmedi).
 */
import { formatSmokeReport, runGeminiSmoke } from "../src/llm/smoke.ts";

runGeminiSmoke(process.env, { args: process.argv.slice(2) }).then(
  (report) => {
    for (const line of formatSmokeReport(report)) process.stdout.write(`${line}\n`);
    process.exit(report.result === "pass" ? 0 : report.result === "refused" ? 2 : 1);
  },
  (error: unknown) => {
    // Yalnizca sinif adi; mesaj ve yigin yazilmaz.
    process.stdout.write(
      `result: FAIL (unexpected ${error instanceof Error ? error.name : "error"})\n`,
    );
    process.exit(1);
  },
);
