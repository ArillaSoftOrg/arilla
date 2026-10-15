/**
 * Trendyol katalog kapsami (karar 0118): katalogdaki Trendyol teklifleri / sitemap urun kimlikleri.
 * YALNIZ OKUR (SELECT). Trendyol'a istek atmaz.
 *
 *   DATABASE_URL=... node --experimental-transform-types --no-warnings \
 *     scripts/trendyol-sitemap-coverage.ts <ids.bin | uretim-klasoru>
 *
 * Girdi: `trendyol-sitemap-snapshot.ts` ciktisi (satir basina contentId .txt dosyalari) ya da
 * uint32 ikili dosya. Bellek: ~4 bayt x kimlik (8,13 M -> ~33 MB).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { sitemapCoverage } from "../src/catalog-collection/trendyol-coverage.ts";

function loadIds(path: string): Uint32Array {
  if (statSync(path).isDirectory()) {
    const list: number[] = [];
    for (const f of readdirSync(path).filter((x) => /^\d+\.txt$/.test(x))) {
      for (const line of readFileSync(join(path, f), "utf8").split("\n"))
        if (line) list.push(Number(line));
    }
    return Uint32Array.from(new Set(list)).sort();
  }
  const b = readFileSync(path);
  return new Uint32Array(b.buffer, b.byteOffset, b.length / 4).slice().sort();
}

const [source] = process.argv.slice(2);
if (!source) {
  process.stderr.write("kullanim: trendyol-sitemap-coverage.ts <ids.bin | uretim-klasoru>\n");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL gerekli\n");
  process.exit(2);
}
const ids = loadIds(source);
const db = createDatabase(url);
const rows = (await db.execute(
  sql`SELECT o.external_id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = 'trendyol'`,
)) as unknown as { rows?: { external_id: string }[] } & { external_id: string }[];
const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
const report = sitemapCoverage(
  ids,
  list.map((r) => r.external_id),
);
process.stdout.write(
  `${JSON.stringify({ ...report, note: "Olculen oran; 8,13 M urunun tamamina erisildigi varsayilmaz." }, null, 1)}\n`,
);
process.exit(0);
