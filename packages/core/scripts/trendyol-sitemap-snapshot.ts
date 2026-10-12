/**
 * Trendyol urun sitemap'inin bir URETIMINI (lastmod) tam ve dogrulanmis olarak indirir;
 * yalnizca contentId saklar. Dusuk bellek: XML akisla okunur, kimlikler dogrudan diske yazilir
 * (45 MB'lik dosya bellege tek metin olarak alinmaz).
 *
 *   node --max-old-space-size=128 --experimental-transform-types --no-warnings \
 *     scripts/trendyol-sitemap-snapshot.ts
 *
 * Cikti: <tmp>/manicepte-trendyol-gen/<lastmod>-v2/
 *   <n>.txt          satir basina bir contentId (gecici dosyadan yeniden adlandirma ile atomik)
 *   progress.json    checkpoint: dosya basina {ids, urls, rejected, bytes, closed, at}, bellek, durum
 * Guvenli devam: ayni lastmod icin progress.json'da tamamlanmis dosyalar atlanir.
 * Surum: basta, her 25 dosyada ve sonda kontrol edilir; degisirse DURUR (uretimler birlestirilmez).
 * Butunluk: govde `</urlset>` ile kapanmali ve her <url> blogu sayilmali (urls = ids + rejected).
 * 403/429: durur, yeniden denemez. Ag hatasi: 60 sn sonra en fazla 1 kez yeniden dener.
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UA = "ManiCepteBot-research/0.1 (+contact: yunuskocaaga1907@gmail.com)";
const root = join(tmpdir(), "manicepte-trendyol-gen");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = () => Math.round(process.memoryUsage().rss / 1_048_576);

interface FileRecord {
  ids: number;
  urls: number;
  rejected: number;
  bytes: number;
  closed: boolean;
  at: string;
}
interface Progress {
  lastmod: string;
  files: number[];
  done: Record<string, FileRecord>;
  status: "running" | "complete" | "stopped";
  stopReason?: string;
  startedAt: string;
  updatedAt: string;
  maxRssMb: number;
}

async function currentGeneration(): Promise<{ lastmod: string; files: number[] } | null> {
  const r = await fetch("https://www.trendyol.com/sitemap_index.xml", {
    headers: { "user-agent": UA },
  });
  if (r.status !== 200) return null;
  const body = await r.text(); // ~370 KB
  const m = [
    ...body.matchAll(
      /<loc>https:\/\/www\.trendyol\.com\/sitemap_products(\d+)\.xml<\/loc>\s*<lastmod>([^<]+)</g,
    ),
  ];
  const mods = [...new Set(m.map((x) => x[2] as string))];
  if (mods.length !== 1) return null;
  return { lastmod: mods[0] as string, files: m.map((x) => Number(x[1])).sort((a, b) => a - b) };
}

// Eski dizini ureten parseProductSitemap ile AYNI kimlik kurali (marka/slug-p-id, ek yol yok).
const LOC = /<loc>https:\/\/www\.trendyol\.com\/[^/<]+\/[^/<?#]+-p-(\d+)<\/loc>/;

/** Tek dosyayi akisla indirir; kimlikleri gecici dosyaya yazar, butunlugu dogrular. */
async function fetchFile(n: number, outFile: string): Promise<FileRecord | { http: number }> {
  const res = await fetch(`https://www.trendyol.com/sitemap_products${n}.xml`, {
    headers: { "user-agent": UA },
  });
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    return { http: res.status };
  }
  const tmp = `${outFile}.part`;
  const out = createWriteStream(tmp);
  const decoder = new TextDecoder();
  let buf = "";
  let ids = 0;
  let urls = 0;
  let rejected = 0;
  let bytes = 0;
  let tail = "";
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    buf += decoder.decode(chunk, { stream: true });
    let end = buf.indexOf("</url>");
    while (end >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 6);
      urls++;
      const m = LOC.exec(block);
      if (m) {
        ids++;
        if (!out.write(`${m[1]}\n`)) await new Promise((r) => out.once("drain", r));
      } else rejected++;
      end = buf.indexOf("</url>");
    }
    tail = (tail + buf).slice(-64);
  }
  buf += decoder.decode();
  tail = (tail + buf).slice(-64);
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  const closed = tail.trimEnd().endsWith("</urlset>");
  if (!closed) {
    await rm(tmp, { force: true });
    return { ids, urls, rejected, bytes, closed, at: new Date().toISOString() };
  }
  await rename(tmp, outFile); // atomik: yarim dosya asla <n>.txt olarak kalmaz
  return { ids, urls, rejected, bytes, closed, at: new Date().toISOString() };
}

const gen = await currentGeneration();
if (!gen) {
  process.stdout.write("sitemap_index okunamadi ya da birden cok lastmod var; durduruldu\n");
  process.exit(1);
}
const dir = join(root, `${gen.lastmod.replace(/:/g, "-")}-v2`);
await mkdir(dir, { recursive: true });
const progressFile = join(dir, "progress.json");
const progress: Progress = existsSync(progressFile)
  ? (JSON.parse(await readFile(progressFile, "utf8")) as Progress)
  : {
      lastmod: gen.lastmod,
      files: gen.files,
      done: {},
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxRssMb: mb(),
    };
if (progress.lastmod !== gen.lastmod) {
  process.stdout.write("klasor baska surume ait; durduruldu\n");
  process.exit(1);
}
progress.status = "running";
delete progress.stopReason;
const save = async () => {
  progress.updatedAt = new Date().toISOString();
  progress.maxRssMb = Math.max(progress.maxRssMb, mb());
  await writeFile(`${progressFile}.tmp`, JSON.stringify(progress, null, 1));
  await rename(`${progressFile}.tmp`, progressFile);
};
const stop = async (reason: string, code: number) => {
  progress.status = "stopped";
  progress.stopReason = reason;
  await save();
  process.stdout.write(`DURDU: ${reason}\n`);
  process.exit(code);
};
await save();
process.stdout.write(`uretim ${gen.lastmod}: ${gen.files.length} dosya -> ${dir}\n`);

let sinceCheck = 0;
for (const n of gen.files) {
  const key = String(n);
  if (progress.done[key]?.closed && existsSync(join(dir, `${n}.txt`))) continue;
  if (sinceCheck >= 25) {
    const again = await currentGeneration();
    if (!again || again.lastmod !== gen.lastmod) {
      await stop(`lastmod degisti (${again?.lastmod ?? "?"}); uretimler birlestirilmez`, 2);
    }
    sinceCheck = 0;
  }
  await sleep(6000);
  let rec: FileRecord | { http: number } | null = null;
  for (let attempt = 0; attempt < 2 && rec == null; attempt++) {
    try {
      rec = await fetchFile(n, join(dir, `${n}.txt`));
    } catch (e) {
      if (attempt === 0) {
        process.stdout.write(
          `dosya ${n}: ag hatasi (${(e as Error).message}); 60 sn sonra tek deneme\n`,
        );
        await sleep(60_000);
      } else await stop(`dosya ${n}: ag hatasi tekrarladi`, 4);
    }
  }
  if (rec && "http" in rec) {
    if (rec.http === 403 || rec.http === 429) await stop(`dosya ${n}: HTTP ${rec.http}`, 3);
    await stop(`dosya ${n}: HTTP ${rec.http}`, 5);
  }
  const r = rec as FileRecord;
  if (!r.closed || r.urls !== r.ids + r.rejected) {
    await stop(`dosya ${n}: butunluk hatasi (closed=${r.closed}, urls=${r.urls}, ids=${r.ids})`, 6);
  }
  progress.done[key] = r;
  sinceCheck++;
  await save();
  const doneCount = Object.keys(progress.done).length;
  process.stdout.write(
    `dosya ${n}: ${r.ids} id (${r.rejected} red, ${(r.bytes / 1e6).toFixed(1)} MB) ${doneCount}/${gen.files.length} rss=${mb()}MB\n`,
  );
}
const final = await currentGeneration();
if (!final || final.lastmod !== gen.lastmod) {
  await stop(`bitiste lastmod degisti (${final?.lastmod ?? "?"})`, 2);
}
progress.status = Object.keys(progress.done).length === gen.files.length ? "complete" : "stopped";
await save();
process.stdout.write(
  `BITTI: ${Object.keys(progress.done).length}/${gen.files.length}, durum ${progress.status}, en yuksek rss ${progress.maxRssMb}MB\n`,
);
