/**
 * Hepsiburada canli urun kesfi - bagimsiz terminal prototipi.
 * Kullanim (packages/core icinden):
 *   node --experimental-transform-types --no-warnings scripts/hepsiburada-discover.ts "iPhone 16 Pro 128 GB"
 * Veritabani, Gemini, Jina ya da uretim kaynagi KULLANMAZ. Engel gorulurse durur.
 */

import { discoverHepsiburada, HEPSIBURADA_ORIGIN } from "../src/hepsiburada-discovery/discover.ts";
import { PoliteFetcher } from "../src/hepsiburada-discovery/polite-fetcher.ts";

const query = process.argv.slice(2).join(" ").trim() || "iPhone 16 Pro 128 GB";

const fetcher = new PoliteFetcher({
  userAgent: "ManiCepteBot-prototype/0.1 (+mailto:yunuskocaaga1907@gmail.com)",
  origin: HEPSIBURADA_ORIGIN,
  maxRequests: 12,
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
});

const report = await discoverHepsiburada(query, fetcher, { maxProducts: 5 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "ok" ? 0 : 2;
