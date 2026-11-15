/**
 * Karar 0203 pilot olcum seti calistiricisi (sohbet sonuc cevabi). DB, uretim, yazma YOK.
 *
 *   # Kuru kosu (varsayilan): sahte model, tavan gerekmez, ag yok
 *   pnpm --filter @arilla/core eval:chat-answer
 *   pnpm --filter @arilla/core eval:chat-answer --limit 20 --max-calls 5 --max-usd 0.01
 *
 *   # GERCEK model (ucretli): --real + IKI tavan da zorunlu; GEMINI_API_KEY ortamdan
 *   GEMINI_API_KEY=... pnpm --filter @arilla/core eval:chat-answer \
 *     --real --max-calls 40 --max-usd 0.10 --limit 40 --baseline 10
 *
 *   # Denetcinin doldurdugu JSON'dan cikis olcutu ozeti
 *   pnpm --filter @arilla/core eval:chat-answer --summarize out/chat-answer-eval/<run>/audit.json
 *
 * Bayraklar: --real | --dry-run, --max-calls N, --max-usd X, --baseline N (gercekler OLMADAN ek
 * N tur: gecikme/maliyet tabani, tavana dahil), --limit N, --ids a,b, --types t1,t2,
 * --ignore-trigger (yonlendirme tetigine bakmadan hepsini modele gonder), --repeat K (1..5),
 * --out DIR (varsayilan out/chat-answer-eval/<kosu>).
 *
 * Tavan sertligi: her cagri ONCESI "harcanan + en kotu durum maliyeti <= max-usd" ve
 * "cagri sayisi < max-calls" sorulur; saglayici istemcisi tek deneme yapar (yeniden deneme yok).
 * Anahtar hicbir yere yazilmaz ya da basilmaz; cikti dosyalarinda yalniz sentetik gercekler ve
 * model cevaplari vardir.
 *
 * Cikis kodu: 0 basarili, 2 reddedildi (gecersiz bayrak/eksik tavan/anahtar yok), 1 beklenmeyen hata.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { GeminiChatInterpreter } from "../src/chat/interpreter.ts";
import {
  type AuditReport,
  aggregate,
  CapTracker,
  type CaseRecord,
  estimateRunCost,
  parseArgs,
  priceRule,
  renderJson,
  renderMarkdown,
  runPilot,
  summarizeReviews,
} from "../src/eval/chat-answer-pilot.ts";
import { PILOT_CASES, PILOT_FACT_SETS } from "../src/eval/chat-answer-pilot-cases.ts";
import {
  DeterministicStubClient,
  STUB_THOUGHT_TOKENS,
} from "../src/eval/chat-answer-pilot-stub.ts";
import type { LlmClient } from "../src/llm/client.ts";
import { getLlmClient } from "../src/llm/gemini.ts";
import { GEMINI_MODEL } from "../src/llm/model.ts";

/** Cikti token'i varsayimi (3 paragraf + delil JSON'u); gercek kosu bunu olcer. */
const ASSUMED_OUTPUT_TOKENS = 500;

function refuse(message: string): never {
  process.stdout.write(`result: REFUSED (${message})\n`);
  process.exit(2);
}

/** Her kumeden sirayla: ilk N vaka tum kategorileri kapsasin (tavana takilinca onyargi olmasin). */
function interleave<T extends { id: string; setId: string }>(cases: readonly T[]): T[] {
  const setOrder = new Map(PILOT_FACT_SETS.map((s, i) => [s.id, i]));
  const index = (id: string) => Number(id.split("-").at(-1));
  return [...cases].sort(
    (a, b) =>
      index(a.id) - index(b.id) || (setOrder.get(a.setId) ?? 0) - (setOrder.get(b.setId) ?? 0),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) refuse(parsed.error);
  const options = parsed.options;

  if (options.summarize) {
    const report = JSON.parse(readFileSync(options.summarize, "utf8")) as AuditReport;
    const summary = summarizeReviews(report.records);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(
      `audit bar (>=100 reviewed, 0 critical): ${summary.meetsAuditBar ? "MET" : "NOT MET"}\n`,
    );
    return;
  }

  let client: LlmClient;
  if (options.mode === "real") {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) refuse("GEMINI_API_KEY missing");
    // Tek deneme: tavan, yeniden denemelerle asilmaz. Anahtar yalniz istemciye gider.
    client = getLlmClient(process.env, { maxAttempts: 1, timeoutMs: 20_000 });
  } else {
    client = new DeterministicStubClient();
  }

  let selected = interleave(PILOT_CASES);
  if (options.ids) selected = selected.filter((c) => options.ids?.includes(c.id));
  if (options.types) selected = selected.filter((c) => options.types?.includes(c.type));
  if (options.limit) selected = selected.slice(0, options.limit);
  if (selected.length === 0) refuse("no cases selected");

  const rule = priceRule();
  const startedAt = new Date();
  const runId = `chat-answer-${startedAt.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${options.mode}`;
  const tracker = new CapTracker(options.maxCalls, options.maxUsd, rule);
  const result = await runPilot(selected, {
    interpreter: new GeminiChatInterpreter(client),
    options,
    tracker,
    rule,
    now: () => performance.now(),
    runId,
  });
  const aggregates = aggregate(result.records, result.baselines, result.stoppedBy);
  const report: AuditReport = {
    meta: {
      runId,
      mode: options.mode,
      model: GEMINI_MODEL,
      startedAt: startedAt.toISOString(),
      caps: { maxCalls: options.maxCalls, maxUsd: options.maxUsd },
      priceRuleId: rule.id,
      note:
        options.mode === "dry"
          ? "Dry run: stub model, token counts are character estimates; latency and rates are not real."
          : "Real run.",
    },
    aggregates,
    records: result.records,
    baselines: result.baselines,
  };

  const outDir = options.outDir ?? join("out", "chat-answer-eval", runId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "audit.json"), renderJson(report));
  writeFileSync(join(outDir, "audit.md"), renderMarkdown(report));

  const a = aggregates;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`result: OK (${options.mode})`);
  out(`out: ${outDir}`);
  out(
    `records ${a.totalRecords} | ran ${a.ran} | not routed ${a.skippedNotRouted} | cap-skipped ${a.skippedCap} | provider errors ${a.providerErrors}${a.stoppedBy ? ` | STOPPED by ${a.stoppedBy}` : ""}`,
  );
  out(`actions ${JSON.stringify(a.actions)} | rejected ${JSON.stringify(a.rejectionReasons)}`);
  out(
    `valid rate ${a.validRate === null ? "-" : (a.validRate * 100).toFixed(1)}% (${a.validated}/${a.answerActions}) | fallback ${a.fallbackRate === null ? "-" : (a.fallbackRate * 100).toFixed(1)}%`,
  );
  out(
    `latency p50/p95 ${a.latencyP50Ms ?? "-"}/${a.latencyP95Ms ?? "-"} ms | avg tokens in/out/thought ${a.avgInputTokens?.toFixed(0) ?? "-"}/${a.avgOutputTokens?.toFixed(0) ?? "-"}/${a.avgThoughtTokens?.toFixed(0) ?? "-"}`,
  );
  out(
    `cost total $${a.totalCostUsd.toFixed(5)} | per turn $${a.costPerTurnUsd?.toFixed(5) ?? "-"} | calls ${tracker.calls}`,
  );
  out(`auto flags ${JSON.stringify(a.flagCounts)}`);

  if (options.mode === "dry") {
    // Gercek kosu maliyet tahmini: kuru kosunun girdi boyutlari + varsayilan cikti/dusunme.
    const inputs = result.records
      .filter((r: CaseRecord) => r.attempts > 0)
      .map((r) => r.inputTokens);
    const assumptions = { outputTokens: ASSUMED_OUTPUT_TOKENS, thoughtTokens: STUB_THOUGHT_TOKENS };
    const one = estimateRunCost(inputs, assumptions, rule);
    const two = estimateRunCost([...inputs, ...inputs], assumptions, rule);
    out(
      `estimate (assumed output ${ASSUMED_OUTPUT_TOKENS} + thought ${STUB_THOUGHT_TOKENS} tokens/turn): ${one.calls} calls, ${one.inputTokens} input tokens -> $${one.costUsd.toFixed(4)}; 2x repeat -> $${two.costUsd.toFixed(4)}`,
    );
  }
}

main().catch((error: unknown) => {
  // Yalnizca sinif adi; mesaj ve yigin yazilmaz (anahtar/metin sizmasin).
  process.stdout.write(
    `result: FAIL (unexpected ${error instanceof Error ? error.name : "error"})\n`,
  );
  process.exit(1);
});
