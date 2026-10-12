/**
 * Tani: verilen Pazarama liste yollarinin 1..N. sayfalarinda kac kart var, kacinda model
 * sozcugu geciyor, kaci kati eslesmeden geciyor. Durust UA, 2 sn aralik, 403/429'da durur.
 *   node --experimental-transform-types --no-warnings scripts/pazarama-diagnose.ts \
 *     "<sorgu>" <sozcuk> <sayfa-sayisi> <yol> [<yol> ...]
 */

import { matchesQuery } from "../src/live-search-browser/match.ts";
import { PazaramaClient, prototypeUserAgent } from "../src/pazarama-discovery/discover.ts";
import { PAZARAMA_ORIGIN, parseListingCards } from "../src/pazarama-discovery/parse.ts";

const [query = "", word = "", pagesRaw = "1", ...paths] = process.argv.slice(2);
const client = new PazaramaClient({
  userAgent: prototypeUserAgent(),
  minIntervalMs: 2_000,
  maxRequests: 20,
  timeoutMs: 15_000,
});
const lc = (s: string) => s.toLocaleLowerCase("tr-TR");

for (const path of paths) {
  for (let page = 1; page <= Number(pagesRaw); page++) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${PAZARAMA_ORIGIN}${path}${page > 1 ? `${sep}sayfa=${page}` : ""}`;
    const t0 = performance.now();
    const res = await client.get(url);
    const ms = Math.round(performance.now() - t0);
    if ("stop" in res) {
      console.log(`STOP HTTP ${res.status}`);
      process.exit(0);
    }
    const cards = res.status === 200 ? parseListingCards(res.body) : [];
    const withWord = cards.filter((c) => lc(c.title).includes(lc(word)));
    const matched = cards.filter((c) => matchesQuery(c.title, query));
    console.log(
      JSON.stringify({
        path,
        page,
        status: res.status,
        ms,
        kb: Math.round(res.body.length / 1024),
        cards: cards.length,
        withWord: withWord.length,
        matched: matched.length,
        priced: matched.filter((c) => c.priceKurus !== null).length,
        samples: withWord.slice(0, 3).map((c) => `${c.title.slice(0, 50)} | ${c.priceKurus}`),
        rejected: withWord
          .filter((c) => !matchesQuery(c.title, query))
          .slice(0, 3)
          .map((c) => c.title.slice(0, 60)),
      }),
    );
    if (cards.length === 0) break;
  }
}
console.log(`requests=${client.requests}`);
