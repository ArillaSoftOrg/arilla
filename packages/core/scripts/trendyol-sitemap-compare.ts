/**
 * Iki sitemap URETIMINI benzersiz contentId uzerinden karsilastirir (dosya numarasindan bagimsiz).
 * Ag istegi ATMAZ.
 *
 *   node --experimental-transform-types --no-warnings --max-old-space-size=4096 \
 *     scripts/trendyol-sitemap-compare.ts <eski-uretim> <yeni-uretim>
 *
 * Uretim argumani:
 *   - "full-index"  : <tmp>/manicepte-trendyol-ids.bin (2026-10-11T16:39:34Z uretiminden kurulan tam dizin)
 *   - "<lastmod>"   : <tmp>/manicepte-trendyol-gen/<lastmod>/ (trendyol-sitemap-snapshot.ts ciktisi)
 * Yeni uretim eksikse (meta.complete !== true) kesin istatistik URETILMEZ; yalnizca kismi ozet yazilir.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Generation {
  label: string;
  ids: Uint32Array;
  complete: boolean;
  lastmod: string | null;
  files: number | null;
}

async function load(arg: string): Promise<Generation> {
  if (arg === "full-index") {
    const b = await readFile(join(tmpdir(), "manicepte-trendyol-ids.bin"));
    return {
      label: "full-index",
      ids: new Uint32Array(b.buffer, b.byteOffset, b.length / 4).slice().sort(),
      complete: true,
      lastmod: "2026-10-11T16:39:34Z",
      files: 337,
    };
  }
  // arg: "<lastmod>" (eski bicim, meta.json) ya da "<lastmod>-v2" (progress.json + butunluk).
  const dir = join(tmpdir(), "manicepte-trendyol-gen", arg.replace(/:/g, "-"));
  const progress = existsSync(join(dir, "progress.json"))
    ? (JSON.parse(await readFile(join(dir, "progress.json"), "utf8")) as {
        lastmod: string;
        files: number[];
        status: string;
        done: Record<string, { ids: number; closed: boolean }>;
      })
    : null;
  const meta = existsSync(join(dir, "meta.json"))
    ? (JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as {
        lastmod?: string;
        files?: number;
        complete?: boolean;
      })
    : {};
  // Dusuk bellek: kimlikler yalnizca buyuyen Uint32Array'de (JS dizisi/Set yok).
  let buf = new Uint32Array(1 << 20);
  let len = 0;
  const parts = (await readdir(dir)).filter((f) => /^\d+\.txt$/.test(f));
  let lineMismatch = 0;
  for (const f of parts) {
    const text = await readFile(join(dir, f), "utf8");
    let count = 0;
    let start = 0;
    while (start < text.length) {
      let nl = text.indexOf("\n", start);
      if (nl < 0) nl = text.length;
      if (nl > start) {
        if (len === buf.length) {
          const bigger = new Uint32Array(buf.length * 2);
          bigger.set(buf);
          buf = bigger;
        }
        buf[len++] = Number(text.slice(start, nl));
        count++;
      }
      start = nl + 1;
    }
    const rec = progress?.done[f.replace(".txt", "")];
    if (rec && rec.ids !== count) lineMismatch++;
  }
  const sorted = buf.subarray(0, len).sort();
  let w = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[w++] = sorted[i] as number;
  }
  const files = progress?.files.length ?? meta.files ?? null;
  const complete = progress
    ? progress.status === "complete" &&
      parts.length === progress.files.length &&
      Object.values(progress.done).every((d) => d.closed) &&
      lineMismatch === 0
    : meta.complete === true && parts.length === meta.files;
  if (lineMismatch > 0) {
    process.stderr.write(`UYARI: ${lineMismatch} dosyada satir sayisi checkpoint ile uyusmuyor\n`);
  }
  return {
    label: arg,
    ids: sorted.slice(0, w),
    complete,
    lastmod: progress?.lastmod ?? meta.lastmod ?? null,
    files,
  };
}

/** Sirali iki kumenin kesisimi (iki isaretci). */
function intersectionSize(a: Uint32Array, b: Uint32Array): number {
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as number;
    const y = b[j] as number;
    if (x === y) {
      n++;
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return n;
}

const [oldArg, newArg] = process.argv.slice(2);
if (!oldArg || !newArg) {
  process.stderr.write("kullanim: trendyol-sitemap-compare.ts <eski> <yeni>\n");
  process.exit(2);
}
const prev = await load(oldArg);
const next = await load(newArg);
const kept = intersectionSize(prev.ids, next.ids);
const hours =
  prev.lastmod && next.lastmod
    ? (Date.parse(next.lastmod) - Date.parse(prev.lastmod)) / 3_600_000
    : null;

const report = {
  previous: {
    label: prev.label,
    lastmod: prev.lastmod,
    files: prev.files,
    uniqueIds: prev.ids.length,
  },
  next: {
    label: next.label,
    lastmod: next.lastmod,
    files: next.files,
    uniqueIds: next.ids.length,
    complete: next.complete,
  },
  generationIntervalHours: hours == null ? null : +hours.toFixed(2),
  peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  retained: kept,
  ...(next.complete && prev.complete
    ? {
        added: next.ids.length - kept,
        removed: prev.ids.length - kept,
        addedPctOfPrevious: +((100 * (next.ids.length - kept)) / prev.ids.length).toFixed(3),
        removedPctOfPrevious: +((100 * (prev.ids.length - kept)) / prev.ids.length).toFixed(3),
        unionUniqueIds: prev.ids.length + next.ids.length - kept,
      }
    : {
        partial: true,
        note: "Yeni uretim eksik: eklenen/silinen orani kesin degil. Yalnizca ornek surekliligi:",
        sampleRetainedPct: next.ids.length ? +((100 * kept) / next.ids.length).toFixed(3) : null,
      }),
};
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
