/**
 * Arastirma harness'i: yalnizca 127.0.0.1. Tarayici tarafi (HB/CS canli arama, HB GTIN)
 * ziyaretci tarayicisinda calisir; Pazarama istekleri bu sunucudan atilir (Pazarama CORS'suz).
 * Uretime bagli DEGILDIR; urun saklamaz, veritabani/Gemini kullanmaz.
 *
 *   PAZARAMA_SEO_INDEX=<dizin.txt> [PAZARAMA_EVIDENCE_FILE=<kanit.jsonl>] \
 *     node --experimental-transform-types --no-warnings scripts/pazarama-live-server.ts <live-search.js paketi>
 *
 * Kanit dosyasi (istege bagli): tarayicinin topladigi GIRDI (sorgu, GTIN, eslesen basliklar,
 * kategori adlari, faset) satir satir yazilir; `pazarama-bench.ts` bu girdilerle yalnizca
 * Pazarama asamasini tekrar tekrar olcer. Urun verisi yazilmaz.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { discoverPazarama } from "../src/pazarama-discovery/combined.ts";
import { PazaramaClient, prototypeUserAgent } from "../src/pazarama-discovery/discover.ts";
import {
  DEFAULT_GATE_OPTIONS,
  type HostGate,
  InMemoryHostGate,
  RedisHostGate,
} from "../src/pazarama-discovery/host-gate.ts";
import { loadSeoIndex, prepareSeoIndex } from "../src/pazarama-discovery/seo-index.ts";
import { getRedis } from "../src/redis/client.ts";

const bundlePath = process.argv[2];
const indexPath = process.env.PAZARAMA_SEO_INDEX;
const evidenceFile = process.env.PAZARAMA_EVIDENCE_FILE;
if (!bundlePath || !indexPath) {
  throw new Error("usage: PAZARAMA_SEO_INDEX=... pazarama-live-server.ts <bundle.js>");
}
const tPrep = performance.now();
const seoIndex = prepareSeoIndex(loadSeoIndex(readFileSync(indexPath, "utf8")));
const prepMs = Math.round(performance.now() - tPrep);
const bundle = readFileSync(bundlePath);

/** Faz 4 sunucu yapilandirmasi (bkz. arastirma-gunlugu.md, 9. oturum). */
export const SERVER_CONFIG = {
  /** Ortak kapi: 1 istek/sn, ayni anda 2, kuyruk 20, en cok 10 sn bekleme, 429'da 15 dk (Retry-After varsa o). */
  gate: { ...DEFAULT_GATE_OPTIONS },
  minIntervalMs: 1_000,
  maxRequests: 24,
  timeoutMs: 12_000,
  discover: {
    maxBarcodes: 4,
    maxVerify: 6,
    maxPagesPerPath: 3,
    targetResults: 4,
    seoPageLimit: 3,
    useListingTotal: true,
    barcodeMaxConsecutiveMisses: 2,
  },
} as const;

const HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Pazarama harness</title></head>
<body><p id="status">loading</p><script type="module">
import * as LS from "./live-search.js";
const [HB, CS] = LS.LIVE_STORES;
const loadImg = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); i.src = u; setTimeout(() => r(false), 8000); });
const ms = (t) => Math.round(performance.now() - t);
async function runQuery(q) {
  const t0 = performance.now();
  const timings = {};
  // HB ve CS aramalari birbirini beklemez (bagimsiz kaynaklar).
  const tSearch = performance.now();
  const [hb, cs] = await Promise.all([
    LS.searchLiveStore(HB, q, { limit: 6 }).then((r) => { timings.hbSearchMs = ms(tSearch); return r; }),
    LS.searchLiveStore(CS, q, { limit: 6 }).then((r) => { timings.csSearchMs = ms(tSearch); return r; }),
  ]);
  // GTIN kesfi: HB urun sayfalari paralel (en cok 3; HB'ye ayni anda 3 istek, normal gezinti hizi).
  const tGtin = performance.now();
  const pages = await Promise.all((hb.ok ? hb.products : []).slice(0, 3).map(async (p) => {
    try { return await (await fetch(p.productUrl, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(10000) })).text(); }
    catch { return ""; }
  }));
  const gtins = [];
  for (const html of pages) for (const g of LS.extractHepsiburadaGtins(html, 3)) if (!gtins.includes(g)) gtins.push(g);
  timings.gtinMs = ms(tGtin);
  timings.browserMs = ms(t0);
  const body = {
    query: q,
    gtins: gtins.slice(0, 6),
    matchedTitles: [...(hb.ok ? hb.products : []), ...(cs.ok ? cs.products : [])].map((p) => p.title),
    categoryNames: cs.ok ? cs.pageCategoryNames : [],
    facetNames: hb.ok ? hb.pageCategoryNames : [],
  };
  const t1 = performance.now();
  const report = await (await fetch("/api/pazarama", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  timings.serverRoundTripMs = ms(t1);
  const tImg = performance.now();
  await Promise.all(report.results.map(async (r) => { r.imageLoaded = r.imageUrl ? await loadImg(r.imageUrl) : false; }));
  timings.imageCheckMs = ms(tImg);
  timings.totalMs = ms(t0);
  return { query: q, timings, hb: hb.ok ? hb.products.length : hb.reason, cs: cs.ok ? cs.products.length : cs.reason, input: body, report };
}
window.__runAll = async (queries) => { window.__out = []; window.__done = false; for (const q of queries) { window.__out.push(await runQuery(q)); } window.__done = true; };
document.getElementById("status").textContent = "ready";
</script></body></html>`;

/**
 * Faz 5: TUM aramalar tek bir host kapisini paylasir (hiz siniri, eszamanlilik, kuyruk,
 * devre kesici, Retry-After). REDIS_URL tanimliysa Redis kapisi (cok instance; Redis yoksa
 * istekler guvenli bicimde reddedilir), degilse bellek ici kapi (tek instance).
 */
const gate: HostGate = process.env.REDIS_URL
  ? new RedisHostGate(getRedis(), SERVER_CONFIG.gate)
  : new InMemoryHostGate(SERVER_CONFIG.gate);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
    return;
  }
  if (req.method === "GET" && url.pathname === "/live-search.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(bundle);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pazarama") {
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 20_000) throw new Error("too large");
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const strings = (v: unknown, max: number) =>
        (Array.isArray(v) ? v : [])
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.slice(0, 200))
          .slice(0, max);
      const input = {
        query: typeof body.query === "string" ? body.query.slice(0, 120) : "",
        gtins: strings(body.gtins, 6),
        matchedTitles: strings(body.matchedTitles, 12),
        categoryNames: strings(body.categoryNames, 6),
        facetNames: strings(body.facetNames, 3),
      };
      if (evidenceFile) appendFileSync(evidenceFile, `${JSON.stringify(input)}\n`);
      const client = new PazaramaClient({
        userAgent: prototypeUserAgent(),
        minIntervalMs: SERVER_CONFIG.minIntervalMs,
        maxRequests: SERVER_CONFIG.maxRequests,
        timeoutMs: SERVER_CONFIG.timeoutMs,
        gate,
      });
      const report = await discoverPazarama(client, input, seoIndex, SERVER_CONFIG.discover);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(report));
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
    return;
  }
  res.writeHead(404).end();
}).listen(4600, "127.0.0.1", () =>
  console.log(
    `pazarama harness on http://127.0.0.1:4600 (${seoIndex.size} paths, prepared in ${prepMs} ms)`,
  ),
);
