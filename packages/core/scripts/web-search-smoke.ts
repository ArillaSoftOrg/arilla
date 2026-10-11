/**
 * Internet urun aramasi GERCEK API dumani (docs/decisions/0102). Veritabani ve
 * Redis'e dokunmaz; en fazla 3 sabit ornek sorgu (kullanici verisi yok); anahtar
 * yalnizca ortamdan okunur ve ASLA yazdirilmaz. Yalnizca yapi, sayilar ve
 * dogrulanmis sonuc ozeti basilir.
 *
 *   WEB_SEARCH_SMOKE=1 GEMINI_API_KEY=... pnpm --filter @arilla/core web-search:smoke [N]
 *
 * Cikis: 0 basarili, 1 basarisiz, 2 reddedildi (istek gonderilmedi).
 */

import type { LlmCall } from "../src/llm/client.ts";
import { estimateGroundingCost, estimateLlmCallCost } from "../src/llm/pricing.ts";
import {
  buildGroundingEvidence,
  buildWebSearchInput,
  buildWebSearchQuery,
  getWebGroundingClient,
  mergeWebCandidates,
  parseAndVerifyCandidates,
  resolveCitationUrls,
  WEB_SEARCH_SYSTEM_INSTRUCTION,
} from "../src/web-search/index.ts";

const QUERIES = [
  "sony wh-1000xm5 kablosuz kulaklik",
  "philips airfryer xxl hd9650",
  "apple airpods pro 2 usb-c",
];

if (process.env.WEB_SEARCH_SMOKE !== "1" || !process.env.GEMINI_API_KEY?.trim()) {
  process.stdout.write(
    "refused: WEB_SEARCH_SMOKE=1 ve GEMINI_API_KEY gerekli (istek gonderilmedi)\n",
  );
  process.exit(2);
}
const count = Math.min(3, Math.max(1, Number(process.argv[2]) || 1));
const client = getWebGroundingClient(process.env);
const fx = process.env.LLM_COST_TRY_PER_USD ?? "41.25";
const env = { LLM_COST_TRY_PER_USD: fx };
let totalGrounding = 0;
let totalMicros = 0;

for (const text of QUERIES.slice(0, count)) {
  const built = buildWebSearchQuery({ kind: "text", text });
  if (!built.ok) continue;
  const calls: LlmCall[] = [];
  const started = Date.now();
  try {
    const res = await client.search(
      { systemInstruction: WEB_SEARCH_SYSTEM_INSTRUCTION, input: buildWebSearchInput(built.query) },
      { onCall: (c) => calls.push(c) },
    );
    const urls = await resolveCitationUrls(res.citations);
    const evidence = buildGroundingEvidence(urls, res.retrieved);
    const { candidates, stats } = parseAndVerifyCandidates(res.text, evidence);
    const groups = mergeWebCandidates({ candidates, query: built.query, features: built.features });
    const queries = new Set(res.searchQueries.map((q) => q.trim().toLowerCase()).filter(Boolean))
      .size;
    const at = new Date();
    const tokenCost = calls.reduce((sum, c) => {
      const e = estimateLlmCallCost(c, { at, env });
      return sum + (e.kind === "estimated" ? e.costMicros : 0);
    }, 0);
    const g = estimateGroundingCost(queries, { at, env });
    const groundingCost = g.kind === "estimated" ? g.costMicros : 0;
    totalGrounding += queries;
    totalMicros += tokenCost + groundingCost;
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`--- sorgu: ${built.query}`);
    out(
      `ms=${Date.now() - started} http=${calls.map((c) => c.httpStatus).join(",")} tokens=${JSON.stringify(res.usage)}`,
    );
    out(
      `citations=${res.citations.length} (google-redirect=${res.citations.filter((c) => c.url.includes("vertexaisearch")).length}) resolved=${urls.length} retrievedPages=${res.retrieved.length} ok=${res.retrieved.filter((r) => r.ok).length}`,
    );
    out(
      `groundingQueries=${queries} searchSuggestions=${res.searchSuggestionsHtml ? `evet(${res.searchSuggestionsHtml.length}b)` : "YOK"}`,
    );
    out(
      `modelCandidates parsed=${stats.received} kept=${candidates.length} rejected=${stats.rejected} groups=${groups.length}`,
    );
    for (const group of groups) {
      out(
        `  [${group.matchKind}] ${group.title.slice(0, 70)} | ${group.offers.map((o) => `${o.host}:${o.priceKurus === null ? "fiyat-yok" : `${o.priceKurus / 100}TL`}`).join(", ")}`,
      );
    }
    out(`maliyet(TRY mikro): token=${tokenCost} grounding=${groundingCost} (kur=${fx})`);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stdout.write(
      `FAIL ${error instanceof Error ? error.name : "error"} ${typeof code === "string" ? code : ""}\n`,
    );
    process.exit(1);
  }
}
process.stdout.write(
  `TOPLAM groundingQueries=${totalGrounding} tahminiMaliyetTRY=${(totalMicros / 1_000_000).toFixed(4)}\n`,
);
