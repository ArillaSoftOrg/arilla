/**
 * Kaydedilmis kanitla tek sorgu calistirir ve dogrulanmis sonuc BASLIKLARINI basar
 * (yanlis eslesme denetimi icin). Urun verisi yazilmaz.
 *   PAZARAMA_SEO_INDEX=<dizin.txt> node --experimental-transform-types --no-warnings \
 *     scripts/pazarama-show.ts <kanit.jsonl> "<sorgu>" ["<sorgu>" ...]
 */

import { readFileSync } from "node:fs";
import {
  discoverPazarama,
  type PazaramaDiscoveryInput,
} from "../src/pazarama-discovery/combined.ts";
import { PazaramaClient, prototypeUserAgent } from "../src/pazarama-discovery/discover.ts";
import { loadSeoIndex, prepareSeoIndex } from "../src/pazarama-discovery/seo-index.ts";

const [evidencePath = "", ...queries] = process.argv.slice(2);
const index = prepareSeoIndex(
  loadSeoIndex(readFileSync(process.env.PAZARAMA_SEO_INDEX ?? "", "utf8")),
);
const inputs = new Map<string, PazaramaDiscoveryInput>();
for (const line of readFileSync(evidencePath, "utf8").split(/\r?\n/).filter(Boolean)) {
  const input = JSON.parse(line) as PazaramaDiscoveryInput;
  inputs.set(input.query, input);
}
for (const q of queries) {
  const input = inputs.get(q);
  if (!input) continue;
  const client = new PazaramaClient({
    userAgent: prototypeUserAgent(),
    minIntervalMs: 1_000,
    maxRequests: 24,
    timeoutMs: 12_000,
  });
  const r = await discoverPazarama(client, input, index, {
    maxBarcodes: 4,
    maxVerify: 6,
    maxPagesPerPath: 3,
    targetResults: 4,
    seoPageLimit: 3,
    useListingTotal: true,
    barcodeMaxConsecutiveMisses: 2,
  });
  console.log(`== ${q} (${r.results.length}, ${r.ms} ms, ${r.requests} req)`);
  for (const x of r.results) {
    console.log(
      `  ${x.title} | ${(x.priceKurus / 100).toFixed(2)} TL${x.priceKind === "basket" ? ` (Sepette fiyatı, koşullar doğrulanmadı; normal ${((x.regularPriceKurus ?? 0) / 100).toFixed(2)})` : ""} | renk ${x.color ?? "-"} | barkod ${x.barcode ?? "-"} | ${x.seller ?? "-"} | ${x.via.join("+")}`,
    );
  }
  for (const x of [...r.barcode.rejected, ...r.seo.rejected]) {
    console.log(`  - elendi: ${x.reason}`);
  }
}
