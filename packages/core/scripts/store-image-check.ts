/**
 * Gercek magaza urun sayfalariyla `attachStoreImages` akisini dener (ag kullanir,
 * Gemini YOK). Kullanim:
 *   node --experimental-transform-types --no-warnings scripts/store-image-check.ts <url>|<baslik> ...
 * Her arguman "adres|urun basligi" biciminde; yalnizca sinif kodlari ve sonuc yazilir.
 */
import { attachStoreImages, type WebProductGroup } from "../src/web-search/index.ts";

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error("usage: store-image-check.ts <url>|<title> ...");
  process.exit(1);
}

const groups: WebProductGroup[] = specs.map((spec, i) => {
  const [url = "", title = ""] = spec.split("|");
  const host = new URL(url).hostname.replace(/^www\./, "");
  return {
    key: `g${i}`,
    title,
    brand: title.split(" ")[0] ?? null,
    matchKind: "exact",
    offers: [
      {
        id: `o${i}`,
        seller: host,
        host,
        url,
        title,
        priceKurus: null,
        priceStatus: "unverified",
        inStock: null,
      },
    ],
    minVerifiedPriceKurus: null,
  };
});

const started = Date.now();
const out = await attachStoreImages(groups, { budgetMs: 20_000 });
for (const group of out) {
  console.log(group.offers[0]?.host, "->", group.imageUrl ?? "NO IMAGE");
}
console.log(`done in ${Date.now() - started} ms`);
