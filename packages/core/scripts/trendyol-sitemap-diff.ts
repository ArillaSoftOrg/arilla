/**
 * Trendyol urun sitemap'i gunluk degisim olcumu (arastirma). Tekrarlanabilir:
 * her calistirmada sabit bir dosya ornegini indirir, onceki anlik goruntuyle
 * karsilastirir (eklenen / silinen contentId) ve yeni goruntuyu kaydeder.
 *
 *   node --experimental-transform-types --no-warnings scripts/trendyol-sitemap-diff.ts [--files 1,150,300]
 *
 * Goruntuler: <tmp>/manicepte-trendyol-sitemap-snapshots/<dosya>/<lastmod>.json
 * Ilk calistirmada, varsa tam dizin onbellegi (<tmp>/manicepte-trendyol-products/<n>.json)
 * temel goruntu olarak kullanilir. 403/429'da durur. Dosyalar arasi 6 sn beklenir.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseProductSitemap } from "../src/trendyol-landing/product-index.ts";

const UA = "ManiCepteBot-research/0.1 (+contact: yunuskocaaga1907@gmail.com)";
const root = join(tmpdir(), "manicepte-trendyol-sitemap-snapshots");
const fullCache = join(tmpdir(), "manicepte-trendyol-products");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const arg = process.argv.indexOf("--files");
const files = (arg >= 0 ? (process.argv[arg + 1] ?? "") : "1,150,300")
  .split(",")
  .map(Number)
  .filter((n) => n >= 1 && n <= 337);

async function get(url: string): Promise<{ status: number; body: string }> {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  return { status: r.status, body: await r.text() };
}

const ids = (paths: { path: string }[]) =>
  new Set(paths.map((p) => p.path.match(/-p-(\d+)$/)?.[1]).filter((x): x is string => !!x));

const index = await get("https://www.trendyol.com/sitemap_index.xml");
if (index.status !== 200) {
  process.stdout.write(`sitemap_index HTTP ${index.status}: durduruldu\n`);
  process.exit(1);
}
const lastmod = new Map(
  [
    // Yalnizca TR koku; /bg/, /de/ vb. dil surumlerinin ayni adli dosyalari haric.
    ...index.body.matchAll(
      /<loc>https:\/\/www\.trendyol\.com\/(sitemap_products\d+\.xml)<\/loc>\s*<lastmod>([^<]+)</g,
    ),
  ].map((m) => [m[1] as string, m[2] as string]),
);

for (const n of files) {
  const name = `sitemap_products${n}.xml`;
  const mod = (lastmod.get(name) ?? "bilinmiyor").replace(/[:]/g, "-");
  const dir = join(root, String(n));
  await mkdir(dir, { recursive: true });
  const snaps = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  let base: Set<string> | null = null;
  let baseLabel = "";
  if (snaps.length > 0) {
    const last = snaps[snaps.length - 1] as string;
    base = new Set(JSON.parse(await readFile(join(dir, last), "utf8")) as string[]);
    baseLabel = last.replace(/\.json$/, "");
  } else if (existsSync(join(fullCache, `${n}.json`))) {
    base = ids(JSON.parse(await readFile(join(fullCache, `${n}.json`), "utf8")));
    baseLabel = "tam-dizin-onbellegi";
  }
  if (snaps.includes(`${mod}.json`)) {
    process.stdout.write(`${name}: lastmod ${mod} zaten kayitli; indirme atlandi\n`);
    continue;
  }
  await sleep(6000);
  const res = await get(`https://www.trendyol.com/${name}`);
  if (res.status === 403 || res.status === 429) {
    process.stdout.write(`${name}: HTTP ${res.status}, durduruldu\n`);
    break;
  }
  if (res.status !== 200) {
    process.stdout.write(`${name}: HTTP ${res.status}, atlandi\n`);
    continue;
  }
  const now = ids(parseProductSitemap(res.body));
  await writeFile(join(dir, `${mod}.json`), JSON.stringify([...now]));
  if (!base) {
    process.stdout.write(`${name}: ilk goruntu ${now.size} urun (lastmod ${mod})\n`);
    continue;
  }
  let added = 0;
  let removed = 0;
  for (const id of now) if (!base.has(id)) added++;
  for (const id of base) if (!now.has(id)) removed++;
  process.stdout.write(
    `${name}: ${baseLabel} -> ${mod}: ${base.size} -> ${now.size} urun, +${added} / -${removed}\n`,
  );
}
