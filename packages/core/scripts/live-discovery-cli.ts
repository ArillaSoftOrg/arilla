/**
 * Trendyol canli urun kesfi test araci (docs/decisions/0106). Prototip:
 * veritabani, Redis, Gemini, Jina KULLANMAZ; hicbir sey saklanmaz.
 *
 *   pnpm --filter @arilla/core live-discovery "iPhone 16 Pro 128 GB"
 *   pnpm --filter @arilla/core live-discovery            (etkilesimli sorgu)
 *
 * Cikis: 0 urun bulundu, 1 bulunamadi/engellendi, 2 kullanim hatasi.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { discoverProducts } from "../src/live-discovery/discover.ts";
import { PoliteFetcher } from "../src/live-discovery/polite-fetcher.ts";

const USER_AGENT = "ManiCepteBot-research/0.1 (+contact: yunuskocaaga1907@gmail.com)";
const SITEMAP_TTL_MS = 24 * 3600 * 1000;
const cacheDir = join(tmpdir(), "manicepte-live-discovery");
const cacheFile = join(cacheDir, "trendyol-sitemap-categories.xml");

async function readQuery(): Promise<string> {
  const arg = process.argv.slice(2).join(" ").trim();
  if (arg) return arg;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Sorgu: ");
  rl.close();
  return answer.trim();
}

const query = await readQuery();
if (query.length < 3 || query.length > 120) {
  process.stderr.write("Sorgu 3-120 karakter olmali.\n");
  process.exit(2);
}

const fetcher = new PoliteFetcher({
  userAgent: USER_AGENT,
  origin: "https://www.trendyol.com",
  maxRequests: 14,
  minIntervalMs: 2500,
});

const result = await discoverProducts(fetcher, {
  query,
  limit: 3,
  loadCachedSitemap: async () => {
    try {
      const st = await stat(cacheFile);
      if (Date.now() - st.mtimeMs > SITEMAP_TTL_MS) return null;
      return await readFile(cacheFile, "utf8");
    } catch {
      return null;
    }
  },
  saveCachedSitemap: async (xml) => {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cacheFile, xml);
    } catch {
      // onbellek yazilamazsa sorun degil
    }
  },
});

const { trace } = result;
process.stdout.write(`\nSorgu: ${query}\n`);
process.stdout.write(
  `Kategori: ${trace.category ?? "-"} | liste ogesi: ${trace.listingItems} | listeden eslesen: ${trace.listingMatches} | gezilen urun sayfasi: ${trace.expansionPagesFetched}\n`,
);
process.stdout.write(
  `Istek sayisi: ${trace.requestCount} | robots ile atlanan: ${trace.robotsSkipped.length} | elenenler: ${JSON.stringify(trace.rejected)}\n`,
);
if (trace.blocked) {
  process.stdout.write(
    `ENGELLENDI: HTTP ${trace.blocked.status} (${trace.blocked.url}); tarama durduruldu.\n`,
  );
}
if (trace.stoppedBecause) process.stdout.write(`Durus nedeni: ${trace.stoppedBecause}\n`);

if (result.products.length === 0) {
  process.stdout.write("\nGercek urun bulunamadi (sahte/sabit veri gosterilmez).\n");
  process.exit(1);
}
process.stdout.write(`\n${result.products.length} urun bulundu:\n`);
for (const p of result.products) {
  process.stdout.write(
    `${JSON.stringify(p, ["title", "price", "currency", "imageUrl", "productUrl", "merchant", "availability", "condition", "lastCheckedAt", "source", "missing"], 2)}\n`,
  );
}
