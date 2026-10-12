/**
 * Pazarama asamasi kiyaslamasi: harness'in kaydettigi GERCEK tarayici kanitlariyla
 * (sorgu, GTIN, basliklar, kategoriler) yalnizca Pazarama kesfini N tur calistirir.
 * Yapilandirmalar: `faz2` (sirali, 2 sn, yalniz 1. sayfa, 2 aday, 4 dogrulama) ve
 * `faz3` (eszamanli, 1 sn slot, siralı sayfalama <=3, 3 aday, 6 dogrulama, hedef 4).
 * Durust UA; 403/429'da tur durur. Urun verisi yazilmaz; yalnizca olcum ozeti basilir.
 *
 *   PAZARAMA_SEO_INDEX=<dizin.txt> node --experimental-transform-types --no-warnings \
 *     scripts/pazarama-bench.ts <kanit.jsonl> <faz2|faz3> <tur>
 */

import { readFileSync } from "node:fs";
import {
  discoverPazarama,
  type PazaramaDiscoveryInput,
} from "../src/pazarama-discovery/combined.ts";
import { PazaramaClient, prototypeUserAgent } from "../src/pazarama-discovery/discover.ts";
import { loadSeoIndex, prepareSeoIndex } from "../src/pazarama-discovery/seo-index.ts";

const [evidencePath = "", mode = "faz3", roundsRaw = "1"] = process.argv.slice(2);
const index = prepareSeoIndex(
  loadSeoIndex(readFileSync(process.env.PAZARAMA_SEO_INDEX ?? "", "utf8")),
);
const inputs = new Map<string, PazaramaDiscoveryInput>();
for (const line of readFileSync(evidencePath, "utf8").split(/\r?\n/).filter(Boolean)) {
  const input = JSON.parse(line) as PazaramaDiscoveryInput;
  inputs.set(input.query, input); // ayni sorgunun en son kaniti
}

const CONFIGS = {
  faz2: {
    client: { minIntervalMs: 2_000, maxRequests: 16, cutoff: false },
    discover: {
      maxBarcodes: 4,
      maxVerify: 4,
      maxPagesPerPath: 1,
      seoPageLimit: 2,
      parallel: false,
      barcodeStopAtTarget: false,
      useListingTotal: false,
    },
  },
  // Faz 3 = 8. oturumdaki davranis (tam sayfa okuma, barkodlar hep denenir).
  faz3: {
    client: { minIntervalMs: 1_000, maxRequests: 24, cutoff: false },
    discover: {
      maxBarcodes: 4,
      maxVerify: 6,
      maxPagesPerPath: 3,
      targetResults: 4,
      seoPageLimit: 3,
      barcodeStopAtTarget: false,
      useListingTotal: false,
    },
  },
  // Faz 4 = ayni erisim sikligi + akis kesme + erken barkod durdurma/birlestirme.
  faz4: {
    client: { minIntervalMs: 1_000, maxRequests: 24, cutoff: true },
    discover: {
      maxBarcodes: 4,
      maxVerify: 6,
      maxPagesPerPath: 3,
      targetResults: 4,
      seoPageLimit: 3,
      barcodeStopAtTarget: true,
      useListingTotal: false,
    },
  },
  // Faz 4b = Faz 4 + toplam sayiya gore sayfalama + barkod iska siniri (2).
  faz4b: {
    client: { minIntervalMs: 1_000, maxRequests: 24, cutoff: true },
    discover: {
      maxBarcodes: 4,
      maxVerify: 6,
      maxPagesPerPath: 3,
      targetResults: 4,
      seoPageLimit: 3,
      barcodeStopAtTarget: true,
      useListingTotal: true,
      barcodeMaxConsecutiveMisses: 2,
    },
  },
} as const;
const cfg = CONFIGS[mode as keyof typeof CONFIGS];
if (!cfg) throw new Error("mode: faz2|faz3|faz4|faz4b");

/**
 * Bagimsiz dogruluk denetimi: sonuc basligi sorgunun modelini GERCEKTEN tasiyor mu
 * (eslestiriciden ayri, elle yazilmis kaliplar). Uyusmayan = yanlis eslesme.
 */
const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr-TR")
    .replace(/[ıİ]/g, "i")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
const ORACLE: Record<string, (t: string) => boolean> = {
  "iPhone 16 Pro 128 GB": (t) =>
    /iphone 16 pro\b/.test(t) && !/\bmax\b/.test(t) && /\b128\s?gb\b/.test(t),
  "Adidas Samba": (t) => /\bsamba\b/.test(t) && !/\bsambae\b/.test(t),
  "Nike Air Force 1": (t) => /\bair force 1\b/.test(t),
  "Sony WH-1000XM5": (t) => /wh\s?1000\s?xm5/.test(t) && !/xm6|xm4/.test(t),
  "Siyah kadın elbise": (t) => /\bsiyah\b/.test(t) && /\belbise/.test(t),
  "PlayStation 5": (t) => /(playstation 5|ps5)/.test(t),
  "Dyson V15": (t) => /\bv15\b/.test(t) && !/\bv15s\b/.test(t),
  "Lego Technic": (t) => /\blego\b/.test(t) && /\btechnic\b/.test(t),
};

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));

const all: number[] = [];
const firsts: number[] = [];
let totalReq = 0;
let totalBytes = 0;
let wrong = 0;
const perQuery = new Map<string, { ms: number[]; results: number[]; requests: number[] }>();
for (let round = 1; round <= Number(roundsRaw); round++) {
  for (const input of inputs.values()) {
    const client = new PazaramaClient({
      userAgent: prototypeUserAgent(),
      timeoutMs: 12_000,
      ...cfg.client,
    });
    const r = await discoverPazarama(client, input, index, cfg.discover);
    all.push(r.ms);
    if (r.timings.firstResultMs !== null) firsts.push(r.timings.firstResultMs);
    totalReq += r.requests;
    totalBytes += r.bytes;
    const oracle = ORACLE[input.query];
    const wrongTitles = oracle
      ? r.results.filter((x) => !oracle(fold(x.title))).map((x) => x.title)
      : [];
    wrong += wrongTitles.length;
    const q = perQuery.get(input.query) ?? { ms: [], results: [], requests: [] };
    q.ms.push(r.ms);
    q.results.push(r.results.length);
    q.requests.push(r.requests);
    perQuery.set(input.query, q);
    console.log(
      JSON.stringify({
        mode,
        round,
        q: input.query,
        ms: r.ms,
        results: r.results.length,
        wrong: wrongTitles,
        ids: r.results.map((x) => x.productId),
        via: r.results.map((x) => x.via.join("+")),
        seoPages: r.seoPages.map((p) => p.path),
        pageHits: r.seo.pageHits.map((h) => `${h.page}:${h.matched}/${h.cards}`),
        list: r.seo.listPagesRead,
        matchedCards: r.seo.matchedCards,
        rejected: [
          ...r.barcode.rejected.map((x) => x.reason.split(":")[0]),
          ...r.seo.rejected.map((x) => x.reason.split(":")[0]),
        ],
        req: r.requests,
        cacheHits: r.cacheHits,
        kb: Math.round(r.bytes / 1024),
        http: r.http,
        t: r.timings,
        early: r.stoppedEarly,
        blocked: r.blockedBy,
      }),
    );
    if (r.blockedBy !== null) {
      console.log(`BLOCKED ${r.blockedBy} - durduruldu`);
      process.exit(0);
    }
  }
}
const rounds = Number(roundsRaw);
console.log(
  JSON.stringify({
    mode,
    rounds,
    queries: inputs.size,
    successfulQueriesPerRound: [...perQuery.values()].filter((q) => Math.min(...q.results) > 0)
      .length,
    totalResultsPerRound: [...perQuery.values()].reduce((s, q) => s + Math.min(...q.results), 0),
    wrongMatches: wrong,
    ms: { mean: mean(all), median: pct(all, 50), p95: pct(all, 95), max: Math.max(...all) },
    firstResultMs: { median: pct(firsts, 50), p95: pct(firsts, 95) },
    requestsPerQuery: Math.round((totalReq / all.length) * 10) / 10,
    mbPerQuery: Math.round((totalBytes / all.length / 1e6) * 100) / 100,
    perQuery: Object.fromEntries(
      [...perQuery].map(([k, v]) => [k, { results: v.results, ms: v.ms, requests: v.requests }]),
    ),
  }),
);
