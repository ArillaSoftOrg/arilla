/**
 * Magaza urun sayfasi gorsel TESHIS betigi (docs/decisions/0102, 0107). Gemini
 * cagirmaz. Verilen urun adresleri icin `store-image.ts` ile AYNI asamalari tek
 * tek raporlar: robots.txt, sayfa erisimi, JSON-LD, og:image, ad eslesmesi, gorsel
 * basliklari. Engeli asmaya CALISMAZ (acik UA, robots ve 401/403/429 saygisi).
 *
 *   node --experimental-transform-types --no-warnings scripts/store-image-probe.ts "<urun adi>" <url> [<url>...]
 */

import { safeGet } from "../src/web-search/safe-fetch.ts";
import {
  extractPageProduct,
  productNameMatches,
  robotsAllows,
} from "../src/web-search/store-image.ts";
import { toSafePublicUrl } from "../src/web-search/url-safety.ts";

const [title, ...urls] = process.argv.slice(2);
if (!title || urls.length === 0) {
  process.stdout.write('kullanim: store-image-probe.ts "<urun adi>" <url>...\n');
  process.exit(2);
}

function line(url: string, text: string): void {
  process.stdout.write(`${new URL(url).host.padEnd(28)} ${text}\n`);
}

for (const raw of urls) {
  const safe = toSafePublicUrl(raw);
  if (!safe) {
    line(raw, "unsafe_url");
    continue;
  }
  const parsed = new URL(safe.url);
  const robots = await safeGet(`https://${safe.host}/robots.txt`, {
    maxBytes: 64_000,
    timeoutMs: 4_000,
    accept: "text/plain",
  });
  if (
    robots?.status === 200 &&
    !robotsAllows(robots.body.toString("utf8"), `${parsed.pathname}${parsed.search}`)
  ) {
    line(raw, "robots_disallow (denenmez)");
    continue;
  }
  let netReason = "";
  const page = await safeGet(safe.url, {
    maxBytes: 400_000,
    timeoutMs: 4_000,
    accept: "text/html,application/xhtml+xml",
    report: (r) => {
      netReason ||= r;
    },
  });
  if (!page) {
    line(raw, `page_unreachable (${netReason || "?"})`);
    continue;
  }
  if (page.status !== 200) {
    line(raw, `page_http_${page.status} (engel/erisim yok; atlatilmaz)`);
    continue;
  }
  const html = page.body.toString("utf8");
  const ld = (html.match(/ld\+json/gi) ?? []).length;
  const og = /property=["']og:image/i.test(html);
  const ogTitle = /property=["']og:title/i.test(html);
  const product = extractPageProduct(html, page.finalUrl);
  const bytes = page.body.length;
  const base = `200 bytes=${bytes}${bytes >= 400_000 ? "(KESILDI)" : ""} ldjson=${ld} og:image=${og} og:title=${ogTitle}`;
  if (!product) {
    line(raw, `${base} -> no_product_data`);
    continue;
  }
  const match = productNameMatches({ title, brand: null }, product.name);
  const image = await safeGet(product.image, {
    maxBytes: 0,
    timeoutMs: 4_000,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.5",
    headersOnly: true,
  });
  line(
    raw,
    `${base} -> pageName="${product.name.slice(0, 60)}" nameMatch=${match} image=${image ? `${image.status} ${image.contentType}` : "unreachable"} ${product.image.slice(0, 70)}`,
  );
}
