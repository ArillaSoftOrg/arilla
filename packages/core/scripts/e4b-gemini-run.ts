/**
 * E4b C+ Gemini kosucusu (yerel deney; ISTEK YOLU DEGIL, veritabanina yazmaz).
 *
 *   GEMINI_API_KEY=... node --experimental-transform-types scripts/e4b-gemini-run.ts \
 *       <queries.tsv> <cikti.jsonl> [--max-calls 120] [--max-usd-micros 100000]
 *
 * - Model: uretimdeki sabit `GEMINI_MODEL` (degistirilemez), mevcut GeminiClient ve
 *   `runIntentV2Predictions` tavan mantigi (en kotu durum on denetimi).
 * - Istemci yeniden denemesi KAPALI (vaka basina en fazla 1 HTTP istegi).
 * - Her vaka bittiginde sonuc JSONL'e eklenir; yeniden calistirmada tamamlanan vakalar ATLANIR
 *   (ayni sorgu icin tekrar cagri yok) ve tavanlar biriken toplamdan devam eder.
 * - Kural 9 notu: deney cagrilari `api_usage`'a yazilmaz (uretim DB'sine dokunulmaz); kullanim ve
 *   maliyet bu JSONL'de satir satir tutulur.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { IntentV2Case } from "../src/eval/intent-v2-eval.ts";
import { type RunContract, runIntentV2Predictions } from "../src/eval/intent-v2-run.ts";
import {
  buildMultilingualInput,
  buildMultilingualInstructions,
  buildMultilingualSchema,
  E4B_CPLUS_RUN_CONFIG,
  multilingualContractHash,
} from "../src/intent/multilingual-experiment.ts";
import { GeminiClient } from "../src/llm/gemini.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};

async function main() {
  const [queriesPath, outPath] = process.argv.slice(2);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!queriesPath || !outPath || !key)
    throw new Error("kullanim: <queries.tsv> <cikti.jsonl> + GEMINI_API_KEY");
  const maxCalls = arg("--max-calls", 120);
  const maxUsd = arg("--max-usd-micros", 100_000);
  // Kayitli 120 cagrinin sozlesmesi; yeni sozlesme (`optional`) ucretli cagri onayi olmadan kosulmaz.
  const config = E4B_CPLUS_RUN_CONFIG;
  const contract: RunContract = {
    instructions: buildMultilingualInstructions(config),
    schema: buildMultilingualSchema(config),
    buildInput: (q) => buildMultilingualInput(q, config),
    contractHash: multilingualContractHash(config),
    maxOutputTokens: 900,
  };
  const done = new Set<string>();
  let calls = 0;
  let spent = 0;
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) {
      const rec = JSON.parse(line) as { id: string; attempts: number; usdMicros: number };
      done.add(rec.id);
      calls += rec.attempts;
      spent += rec.usdMicros;
    }
  }
  const rows = readFileSync(queriesPath, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const client = new GeminiClient(key, { maxAttempts: 1 });
  for (const [id = "", q = "", group = ""] of rows) {
    if (done.has(id)) continue;
    const remainingCalls = maxCalls - calls;
    const remainingUsd = maxUsd - spent;
    if (remainingCalls < 1 || remainingUsd <= 0) {
      console.error(`tavan: cagri ${calls}/${maxCalls}, mikro USD ${spent}/${maxUsd}; durduruldu`);
      break;
    }
    const testCase = {
      id,
      q,
      cat: group,
      lang: "mixed",
      typo: false,
      gold: {},
    } as unknown as IntentV2Case;
    const { predictions, report } = await runIntentV2Predictions(
      [testCase],
      client,
      { maxCalls: remainingCalls, maxUsdMicros: remainingUsd, attemptsPerCase: 1 },
      { contract },
    );
    const rec = report.records[0];
    if (!rec) continue;
    if (rec.status === "skipped_budget") {
      console.error(`tavan on denetimi: ${id} baslatilmadi; durduruldu`);
      break;
    }
    calls += rec.attempts;
    spent += rec.usdMicros;
    appendFileSync(
      outPath,
      `${JSON.stringify({
        id,
        query: q,
        group,
        status: rec.status,
        attempts: rec.attempts,
        latencyMs: rec.latencyMs,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        usdMicros: rec.usdMicros,
        model: report.model,
        priceRuleId: report.priceRuleId,
        contractHash: report.contractHash,
        raw: predictions[id] ?? null,
      })}\n`,
    );
  }
  console.log(JSON.stringify({ calls, spentUsdMicros: spent, done: done.size }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : "hata");
    process.exit(1);
  });
