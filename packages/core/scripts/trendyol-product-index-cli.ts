/**
 * Trendyol urun sitemap metadata dizini (arastirma prototipi).
 * Veritabani/Redis/model yok. Fiyat YOK (sitemap tasimaz).
 *
 *   # dizin kur (kaldigi yerden devam eder; 403/429'da durur)
 *   node --experimental-transform-types --no-warnings scripts/trendyol-product-index-cli.ts build [--files 1-337]
 *   # ara
 *   node --experimental-transform-types --no-warnings scripts/trendyol-product-index-cli.ts search "iPhone 16 Pro 128 GB"
 *
 * Onbellek: <os.tmpdir()>/manicepte-trendyol-products/<n>.json (her dosya ~1 MB).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProductIndex,
  parseProductSitemap,
  type SitemapProduct,
} from "../src/trendyol-landing/product-index.ts";

const UA = "ManiCepteBot-research/0.1 (+contact: yunuskocaaga1907@gmail.com)";
const dir = join(tmpdir(), "manicepte-trendyol-products");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function range(spec: string): number[] {
  const [a, b] = spec.split("-").map(Number);
  const out: number[] = [];
  for (let i = a ?? 1; i <= (b ?? a ?? 1); i++) out.push(i);
  return out;
}

async function build(files: number[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const n of files) {
    const file = join(dir, `${n}.json`);
    if (existsSync(file)) continue;
    const res = await fetch(`https://www.trendyol.com/sitemap_products${n}.xml`, {
      headers: { "user-agent": UA },
    });
    if (res.status === 403 || res.status === 429) {
      process.stdout.write(`HTTP ${res.status} (dosya ${n}): durduruldu, yeniden denenmez.\n`);
      return;
    }
    if (res.status !== 200) {
      process.stdout.write(`dosya ${n}: HTTP ${res.status}, atlandi\n`);
      continue;
    }
    const items = parseProductSitemap(await res.text());
    await writeFile(file, JSON.stringify(items));
    process.stdout.write(`dosya ${n}: ${items.length} urun\n`);
    await sleep(6000);
  }
}

async function load(): Promise<{ index: ProductIndex; files: number }> {
  const index = new ProductIndex();
  const names = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".json")) : [];
  for (const f of names) {
    index.add(JSON.parse(await readFile(join(dir, f), "utf8")) as SitemapProduct[]);
  }
  return { index, files: names.length };
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "build") {
  const i = rest.indexOf("--files");
  await build(range(i >= 0 ? (rest[i + 1] ?? "1-337") : "1-337"));
} else if (cmd === "search") {
  const query = rest.join(" ").trim();
  const t0 = performance.now();
  const { index, files } = await load();
  const t1 = performance.now();
  const hits = index.search(query, 10);
  const t2 = performance.now();
  process.stdout.write(
    `dizin: ${index.size} urun (${files}/337 dosya) yukleme ${Math.round(t1 - t0)} ms, arama ${Math.round(t2 - t1)} ms\n`,
  );
  process.stdout.write(`"${query}": ${hits.length} sonuc\n${JSON.stringify(hits, null, 2)}\n`);
} else {
  process.stderr.write("kullanim: build [--files 1-337] | search <sorgu>\n");
  process.exit(2);
}
