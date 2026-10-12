/**
 * Trendyol urun sitemap'inin bir URETIMINI (lastmod) tam olarak indirir; yalnizca contentId saklar.
 * Dosya numarasi her uretimde anlamini yitirdigi icin (urunler yeniden dagitiliyor), karsilastirma
 * yalnizca benzersiz kimlik kumeleri uzerinden yapilmalidir (bkz. trendyol-sitemap-compare.ts).
 *
 *   node --experimental-transform-types --no-warnings scripts/trendyol-sitemap-snapshot.ts
 *
 * Cikti: <tmp>/manicepte-trendyol-gen/<lastmod>/<n>.txt (satir basina bir contentId) ve meta.json.
 * Kaldigi yerden devam eder. 6 sn aralik; 403/429'da durur. Indirme sirasinda sitemap_index'in
 * lastmod'u degisirse "karisik uretim" olarak isaretler ve durur (yarim kume karsilastirilmaz).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UA = "ManiCepteBot-research/0.1 (+contact: yunuskocaaga1907@gmail.com)";
const root = join(tmpdir(), "manicepte-trendyol-gen");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ status: number; body: string }> {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  return { status: r.status, body: await r.text() };
}

async function currentGeneration(): Promise<{ lastmod: string; files: number[] } | null> {
  const res = await get("https://www.trendyol.com/sitemap_index.xml");
  if (res.status !== 200) return null;
  const m = [
    ...res.body.matchAll(
      /<loc>https:\/\/www\.trendyol\.com\/sitemap_products(\d+)\.xml<\/loc>\s*<lastmod>([^<]+)</g,
    ),
  ];
  const mods = [...new Set(m.map((x) => x[2] as string))];
  if (mods.length !== 1) return null;
  return { lastmod: mods[0] as string, files: m.map((x) => Number(x[1])).sort((a, b) => a - b) };
}

const gen = await currentGeneration();
if (!gen) {
  process.stdout.write("sitemap_index okunamadi ya da birden cok lastmod var; durduruldu\n");
  process.exit(1);
}
const dir = join(root, gen.lastmod.replace(/:/g, "-"));
await mkdir(dir, { recursive: true });
const metaFile = join(dir, "meta.json");
const meta = existsSync(metaFile)
  ? (JSON.parse(await readFile(metaFile, "utf8")) as Record<string, unknown>)
  : { lastmod: gen.lastmod, files: gen.files.length, startedAt: new Date().toISOString() };
await writeFile(metaFile, JSON.stringify(meta, null, 1));
process.stdout.write(`uretim ${gen.lastmod}: ${gen.files.length} dosya -> ${dir}\n`);

let done = 0;
for (const n of gen.files) {
  const out = join(dir, `${n}.txt`);
  if (existsSync(out)) {
    done++;
    continue;
  }
  if (done > 0 && done % 50 === 0) {
    const again = await currentGeneration();
    if (!again || again.lastmod !== gen.lastmod) {
      process.stdout.write(
        `lastmod degisti (${again?.lastmod ?? "?"}): karisik uretim, durduruldu\n`,
      );
      await writeFile(metaFile, JSON.stringify({ ...meta, mixedGeneration: true }, null, 1));
      process.exit(2);
    }
  }
  await sleep(6000);
  const res = await get(`https://www.trendyol.com/sitemap_products${n}.xml`);
  if (res.status === 403 || res.status === 429) {
    process.stdout.write(`dosya ${n}: HTTP ${res.status}, durduruldu\n`);
    process.exit(3);
  }
  if (res.status !== 200) {
    process.stdout.write(`dosya ${n}: HTTP ${res.status}, atlandi\n`);
    continue;
  }
  const ids = [
    // Eski dizini ureten parseProductSitemap ile AYNI kural (marka/slug-p-id, ek yol yok);
    // farkli kural sahte ekleme/silme uretir.
    ...res.body.matchAll(/<loc>https:\/\/www\.trendyol\.com\/[^/<]+\/[^/<?#]+-p-(\d+)<\/loc>/g),
  ].map((m) => m[1]);
  await writeFile(out, ids.join("\n"));
  done++;
  process.stdout.write(`dosya ${n}: ${ids.length} (${done}/${gen.files.length})\n`);
}
await writeFile(
  metaFile,
  JSON.stringify(
    { ...meta, completedAt: new Date().toISOString(), complete: done === gen.files.length },
    null,
    1,
  ),
);
process.stdout.write(`tamam: ${done}/${gen.files.length}\n`);
