/**
 * Trendyol liste sayfasi kesfi prototipi (arastirma). Veritabani/Redis/model yok.
 *
 *   node --experimental-transform-types --no-warnings scripts/trendyol-landing-cli.ts "iPhone 16 Pro 128 GB" [--resolve-only]
 *
 * Dizin (yalnizca liste sayfasi adresleri, urun verisi degil) Trendyol'un
 * yayinladigi sitemap'lerden indirilir ve 24 saat yerel gecici dizinde tutulur.
 * Liste sayfasi Node fetch ile, durust User-Agent ile istenir; 403/429'da durur.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverTrendyol } from "../src/trendyol-landing/discover.ts";
import {
  type LandingEntry,
  parseLandingSitemap,
  resolveLandings,
} from "../src/trendyol-landing/landing-index.ts";
import { parseRobots } from "../src/trendyol-landing/robots.ts";

const UA = "ManiCepteBot-research/0.1 (+contact: yunuskocaaga1907@gmail.com)";
const ORIGIN = "https://www.trendyol.com";
const FILES = [
  ...[1, 2, 3, 4, 5, 6].map((i) => `sitemap_search_combinations${i}.xml`),
  ...[1, 2, 3].map((i) => `sitemap_search_with_attributes${i}.xml`),
  "sitemap_brands.xml",
  ...[1, 2, 3].map((i) => `sitemap_special_landing${i}.xml`),
];
const cacheDir = join(tmpdir(), "manicepte-trendyol-landing");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xml" },
  });
  return { status: res.status, body: await res.text() };
}

async function loadIndex(): Promise<LandingEntry[]> {
  const file = join(cacheDir, "index.json");
  try {
    if (Date.now() - (await stat(file)).mtimeMs < 24 * 3600 * 1000) {
      return JSON.parse(await readFile(file, "utf8"));
    }
  } catch {}
  const index: LandingEntry[] = [];
  for (const f of FILES) {
    const res = await get(`${ORIGIN}/${f}`);
    if (res.status !== 200) throw new Error(`${f}: HTTP ${res.status}`);
    index.push(...parseLandingSitemap(res.body));
    await sleep(4000);
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(index));
  return index;
}

const args = process.argv.slice(2);
const resolveOnly = args.includes("--resolve-only");
const query = args
  .filter((a) => !a.startsWith("--"))
  .join(" ")
  .trim();
if (query.length < 3) {
  process.stderr.write('Kullanim: trendyol-landing-cli.ts "<sorgu>" [--resolve-only]\n');
  process.exit(2);
}

const index = await loadIndex();
process.stdout.write(`Dizin: ${index.length} liste sayfasi\n`);
for (const c of resolveLandings(index, query, 3)) {
  process.stdout.write(`  aday ${c.score}  ${c.entry.path}\n`);
}
if (resolveOnly) process.exit(0);

const robotsRes = await get(`${ORIGIN}/robots.txt`);
if (robotsRes.status !== 200) {
  process.stdout.write(`robots.txt alinamadi (HTTP ${robotsRes.status}); tarama yapilmadi.\n`);
  process.exit(1);
}
await sleep(3000);
const result = await discoverTrendyol({
  query,
  index,
  robots: parseRobots(robotsRes.body, UA),
  transport: async (url) => {
    const r = await get(url);
    await sleep(3000);
    return r;
  },
});
for (const p of result.pages) {
  process.stdout.write(`  sayfa ${p.status}  liste:${p.listed} eslesen:${p.matched}  ${p.url}\n`);
}
if (result.stoppedBecause) process.stdout.write(`Durus: ${result.stoppedBecause}\n`);
process.stdout.write(`${JSON.stringify(result.products, null, 2)}\n`);
process.exit(result.products.length > 0 ? 0 : 1);
