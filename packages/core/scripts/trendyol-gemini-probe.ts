/**
 * H9 olcumu: Gemini URL Context Trendyol urun fiyatini dogru okuyor mu? (docs/research/trendyol-search/14)
 *
 *   node --env-file=../../.env.trendyol-research --experimental-transform-types --no-warnings \
 *     scripts/trendyol-gemini-probe.ts --set <set.json>                 # yalnizca hazirlik + anahtar kontrolu
 *   ... --set <set.json> --run [--mode url|search] [--max 20]           # olcum (sonuc OS gecici klasorune)
 *   ... --compare <probe.json> --truth <truth.json> [--window-min 20]   # cevrimdisi karsilastirma, ag yok
 *
 * set.json:   [{ "contentId": "857296094", "path": "apple/...-p-857296094", "query": "...", "seller": "Akarsu" }]
 * truth.json: PriceObservation[] (gercek tarayicida, normal ziyaret, ayni dakikalarda; kind page.*)
 *
 * Kurallar (kodda zorunlu):
 *  - Yalnizca `GEMINI_FREE_TIER_API_KEY` (AI Studio, faturalandirmasi KAPALI proje). Anahtar
 *    production ortam dosyalarindaki GEMINI_API_KEY ile ayniysa calismaz.
 *  - Istekler arasi 13 sn (ucretsiz katman dakika siniri), tek deneme; ilk 429'da DURUR.
 *  - Varsayilan en fazla 20 istek. Stdout'a anahtar, istem ya da sayfa metni yazilmaz.
 *  - `search` kipinde Google Search grounding sonuclari SAKLANMAZ (Google sartlari): yalnizca
 *    sayilar yazilir. `url` kipinde model ciktisi yer gercegiyle karsilastirma icin gecici
 *    klasore yazilir; karsilastirmadan sonra silinmelidir.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compareWithTruth,
  contentIdOf,
  freeTierGate,
  GEMINI_FREE_MODEL,
  geminiKeysFromEnvText,
  type ProbeMode,
  type ProbeResult,
  probe,
} from "../src/trendyol-landing/gemini-url-context.ts";
import type { PriceObservation } from "../src/trendyol-landing/price-observation.ts";

interface SetItem {
  contentId: string;
  path: string;
  query?: string;
  seller?: string;
}
interface ProbeRecord {
  contentId: string;
  probedAt: string;
  mode: ProbeMode;
  result: ProbeResult;
}

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const n = Number(arg(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Cevrimdisi karsilastirma -------------------------------------------------
const compareFile = arg("--compare");
if (compareFile) {
  const records = JSON.parse(readFileSync(compareFile, "utf8")) as ProbeRecord[];
  const truth = JSON.parse(readFileSync(arg("--truth") ?? "", "utf8")) as PriceObservation[];
  const sellers = new Map<string, string>();
  const setFile = arg("--set");
  if (setFile) {
    for (const s of JSON.parse(readFileSync(setFile, "utf8")) as SetItem[]) {
      if (s.seller) sellers.set(s.contentId, s.seller);
    }
  }
  const rows = records
    .filter((r) => r.mode === "url_context")
    .map((r) =>
      compareWithTruth(
        r.contentId,
        r.result,
        r.probedAt,
        truth,
        sellers.get(r.contentId) ?? null,
        num("--window-min", 20),
      ),
    );
  const count = (f: (x: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const withTruth = rows.filter((r) => r.truthAvailable && r.priceReturned);
  const kinds: Record<string, number> = {};
  for (const r of rows) for (const k of r.matchedKinds) kinds[k] = (kinds[k] ?? 0) + 1;
  out({ rows });
  out({
    summary: {
      probes: rows.length,
      retrievedOk: count((r) => r.retrievedOk),
      priceReturned: count((r) => r.priceReturned),
      evidenceConsistent: count((r) => r.evidenceConsistent),
      truthAvailable: count((r) => r.truthAvailable),
      matchesDisplayed: count((r) => r.matchesDisplayed === true),
      comparable: withTruth.length,
      matchedAnyLayer: count((r) => r.matchedKinds.length > 0),
      matchedKinds: kinds,
      sellerMatches: count((r) => r.sellerMatches === true),
      sellerComparable: count((r) => r.sellerMatches !== null),
    },
  });
  process.exit(0);
}

// --- Hazirlik ------------------------------------------------------------------
const repoRoots = [resolve("../.."), resolve("../../../repo-docs")];
const productionKeys: string[] = [];
for (const root of repoRoots) {
  for (const f of [".env.vercel", ".env", ".env.local", "apps/web/.env.local", "apps/web/.env"]) {
    const p = join(root, f);
    if (existsSync(p)) productionKeys.push(...geminiKeysFromEnvText(readFileSync(p, "utf8")));
  }
}
const gate = freeTierGate(process.env, productionKeys);
out({
  model: GEMINI_FREE_MODEL,
  ready: gate.ready,
  reason: gate.reason,
  productionKeysChecked: productionKeys.length,
});

const setFile = arg("--set");
const items: SetItem[] = setFile ? (JSON.parse(readFileSync(setFile, "utf8")) as SetItem[]) : [];
out({ setItems: items.length });
if (!gate.ready || !gate.apiKey) process.exit(0);

// Anahtar dogrulamasi: model bilgisi (token harcamaz).
const meta = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FREE_MODEL}`,
  {
    headers: { "x-goog-api-key": gate.apiKey },
    signal: AbortSignal.timeout(15_000),
  },
).catch(() => null);
out({ keyCheck: meta ? meta.status : "network" });
await meta?.body?.cancel().catch(() => {});
if (!meta?.ok || !process.argv.includes("--run")) {
  if (!process.argv.includes("--run"))
    out({ note: "Olcum icin --run. Model istegi gonderilmedi." });
  process.exit(0);
}

// --- Olcum ----------------------------------------------------------------------
const mode: ProbeMode = arg("--mode") === "search" ? "search_and_url_context" : "url_context";
const max = Math.min(num("--max", 20), 40);
const records: ProbeRecord[] = [];
let sent = 0;
for (const item of items) {
  if (sent >= max) break;
  if (mode === "search_and_url_context" && !item.query) continue;
  const url = `https://www.trendyol.com/${item.path}`;
  const probedAt = new Date().toISOString();
  const result = await probe(
    gate.apiKey,
    mode,
    mode === "url_context" ? { url } : { query: item.query },
  );
  sent++;
  const trendyolPages = result.pages.filter((p) => contentIdOf(p.url) !== null);
  out({
    contentId: item.contentId,
    mode,
    failure: result.failure,
    latencyMs: result.latencyMs,
    retrieved: result.retrieved.map((r) => r.status),
    groundingSources: result.groundingUris.length,
    pages: result.pages.length,
    trendyolPages: trendyolPages.length,
    sameContent: result.pages.some((p) => contentIdOf(p.url) === item.contentId),
    priced: trendyolPages.filter((p) => p.priceKurus !== null).length,
    evidenceConsistent: trendyolPages.filter((p) => p.evidenceConsistent).length,
    tokens: result.tokens,
    shape: result.shape,
  });
  if (mode === "url_context") records.push({ contentId: item.contentId, probedAt, mode, result });
  if (result.httpStatus === 429) {
    out({ stopped: "http_429: ucretsiz kota/dakika siniri; ucretli istek yok, olcum durdu" });
    break;
  }
  if (result.httpStatus !== null && result.httpStatus >= 400 && result.httpStatus !== 429) {
    out({ stopped: `http_${result.httpStatus}` });
    break;
  }
  await sleep(13_000);
}
if (records.length > 0) {
  const file = join(tmpdir(), `trendyol-gemini-probe-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(records));
  out({
    probeFile: file,
    note: "Depo disinda; --compare ile yer gercegine karsilastirin, sonra silin.",
  });
}
out({ sent });
