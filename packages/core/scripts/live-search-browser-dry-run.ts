/**
 * Karar 0117 kuru calismasi: KAYITLI HTML dosyalari uzerinde (ag istegi YOK).
 *
 *   node --experimental-transform-types --no-warnings scripts/live-search-browser-dry-run.ts \
 *     --product <url>=<html-dosyasi> ... --listing <html-dosyasi> ... [--ledger <json>]
 *
 * Cikti: alan bazinda erisilebilirlik, sitemap eslesmesi (<tmp>/manicepte-trendyol-ids.bin),
 * katalog satir onizlemesi, liste sayfasi basina kapsam ve yenileme kotasi durumu.
 * Veritabanina yazmaz; production aktarimi yoktur. Bayrak kapaliysa calismaz.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canStartCycle,
  catalogRowsFromObservation,
  emptyLedger,
  extractTrendyolProductPage,
  isTrendyolBrowserReadEnabled,
  matchToSitemap,
  pageInputsFromHtml,
  type RefreshLedger,
  type SitemapGeneration,
} from "../src/live-search-browser/index.ts";
import { findSearchProps, listingProducts } from "../src/trendyol-landing/listing.ts";

if (!isTrendyolBrowserReadEnabled(process.env)) {
  process.stdout.write(
    "TRENDYOL_BROWSER_READ_ENABLED=true degil; calismadi (varsayilan kapali).\n",
  );
  process.exit(0);
}

const args = process.argv.slice(2);
const products: { url: string; file: string }[] = [];
const listings: string[] = [];
let ledgerPath: string | null = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === "--product" && v) {
    const eq = v.indexOf("=");
    products.push({ url: v.slice(0, eq), file: v.slice(eq + 1) });
    i++;
  } else if (a === "--listing" && v) {
    listings.push(v);
    i++;
  } else if (a === "--ledger" && v) {
    ledgerPath = v;
    i++;
  }
}

async function loadGeneration(): Promise<SitemapGeneration | null> {
  const p = join(tmpdir(), "manicepte-trendyol-ids.bin");
  if (!existsSync(p)) return null;
  const b = await readFile(p);
  const ids = new Uint32Array(b.buffer, b.byteOffset, b.length / 4).slice().sort();
  return { lastmod: "2026-10-11T16:39:34Z", ids };
}

const gen = await loadGeneration();
const report: Record<string, unknown> = {
  generation: gen ? { lastmod: gen.lastmod, ids: gen.ids.length } : null,
};

const productReports = [];
for (const { url, file } of products) {
  const html = await readFile(file, "utf8");
  const obs = extractTrendyolProductPage(pageInputsFromHtml(html, url, new Date(0).toISOString()));
  const sitemap = gen ? matchToSitemap(obs.contentId, gen) : { status: "no_content_id" as const };
  const rows = catalogRowsFromObservation(obs, sitemap);
  productReports.push({
    file,
    source: obs.source,
    contentId: obs.contentId,
    fields: {
      title: obs.title,
      priceKurus: obs.offer?.prices ?? null,
      jsonLdPriceKurus: obs.jsonLd?.priceKurus ?? null,
      jsonLdMatchesDiscounted: obs.jsonLdMatchesDiscounted,
      image: obs.images.length,
      seller: obs.seller,
      variants: obs.variants.length,
      stock: {
        inStock: obs.offer?.inStock ?? null,
        runningOut: obs.offer?.runningOutQuantity ?? null,
        jsonLd: obs.jsonLd?.availability ?? null,
      },
      gtin14: obs.offer?.gtin14 ?? null,
      otherMerchantCount: obs.otherMerchantCount,
      groupSiblings: obs.jsonLd?.groupSiblings.length ?? 0,
    },
    missing: obs.missing,
    sitemap,
    catalog: {
      offer: rows.offer?.external_id ?? null,
      current_price: rows.offer?.current_price ?? null,
      variants: rows.variants.length,
      pricePoint: rows.pricePoint != null,
      skipped: rows.skipped,
    },
  });
}
report.products = productReports;

const listingReports = [];
for (const file of listings) {
  const html = await readFile(file, "utf8");
  const items = listingProducts(findSearchProps(html), "dry-run");
  const ids = [...new Set(items.map((p) => p.contentId).filter((x): x is string => x != null))];
  const inSitemap = gen
    ? ids.filter((id) => matchToSitemap(id, gen).status === "in_sitemap").length
    : null;
  listingReports.push({
    file,
    cards: items.length,
    uniqueContentIds: ids.length,
    withPrice: items.filter((p) => p.priceKurus != null).length,
    withSellerId: items.filter((p) => p.supplierId != null).length,
    withStock: 0,
    inSitemap,
  });
}
report.listings = listingReports;

let ledger: RefreshLedger = emptyLedger();
if (ledgerPath && existsSync(ledgerPath))
  ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as RefreshLedger;
report.refresh = { canStartNow: canStartCycle(ledger, new Date()), cycles: ledger.cycles.length };

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
