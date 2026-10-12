/**
 * Pazarama SEO yol dizinini yeniden uretir (arastirma prototipi). Yalnizca YOL saklanir,
 * urun verisi saklanmaz. Kaynak: robots.txt'te ilan edilen sitemap'ler.
 * Kullanim (packages/core icinden):
 *   node --experimental-transform-types --no-warnings scripts/pazarama-seo-index.ts <cikti.txt>
 * Durust UA, 3 sn aralik, 403/429'da durur. ~19 istek, ~120 MB indirme.
 */

import { writeFileSync } from "node:fs";
import { PazaramaClient, prototypeUserAgent } from "../src/pazarama-discovery/discover.ts";
import { PAZARAMA_ORIGIN } from "../src/pazarama-discovery/parse.ts";
import { SEO_FAMILIES, sitemapPaths } from "../src/pazarama-discovery/seo-index.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: pazarama-seo-index.ts <output.txt>");

const client = new PazaramaClient({
  userAgent: prototypeUserAgent(),
  minIntervalMs: 3_000,
  maxRequests: 40,
  timeoutMs: 120_000,
});

const paths = new Set<string>();
const counts: Record<string, number> = {};
for (const family of SEO_FAMILIES) {
  const index = await client.get(`${PAZARAMA_ORIGIN}/sitemaps/${family}/sitemap.xml`);
  if ("stop" in index || index.status !== 200) throw new Error(`index ${family}: ${index.status}`);
  const children = sitemapPaths(index.body, PAZARAMA_ORIGIN).filter((p) =>
    p.startsWith("/sitemaps/"),
  );
  counts[family] = 0;
  for (const child of children) {
    const res = await client.get(`${PAZARAMA_ORIGIN}${child}`);
    if ("stop" in res) throw new Error(`stopped at ${child}: HTTP ${res.status}`);
    if (res.status !== 200) continue;
    for (const p of sitemapPaths(res.body, PAZARAMA_ORIGIN)) {
      paths.add(p);
      counts[family] += 1;
    }
  }
}

const header = `# pazarama-seo-index v1 generated=${new Date().toISOString()} ${JSON.stringify(counts)} requests=${client.requests}`;
writeFileSync(out, `${header}\n${[...paths].sort().join("\n")}\n`);
console.log(header, `unique=${paths.size}`);
