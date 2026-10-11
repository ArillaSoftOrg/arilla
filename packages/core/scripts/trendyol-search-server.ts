/**
 * Bagimsiz arastirma arayuzu (ManiCepte production'indan ayri). Eklentisiz;
 * istek aninda Trendyol'a HIC istek atmaz. Yalnizca onceden kurulmus iki dizini okur:
 *   - urun sitemap dizini  (<tmp>/manicepte-trendyol-products/*.json): ad, gorsel, baglanti
 *   - liste sayfasi dizini (<tmp>/manicepte-trendyol-landing/index.json): en uygun Trendyol sayfasi
 * Fiyat ve stok bu kaynaklarda YOK; uydurulmaz, kartta "fiyat Trendyol'da" yazar.
 *
 *   node --experimental-transform-types --no-warnings scripts/trendyol-search-server.ts
 *   -> http://127.0.0.1:5179/?q=Nike+Air+Force+1
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LandingEntry, resolveLandings } from "../src/trendyol-landing/landing-index.ts";
import {
  type IndexedProduct,
  ProductIndex,
  type SitemapProduct,
} from "../src/trendyol-landing/product-index.ts";

const productDir = join(tmpdir(), "manicepte-trendyol-products");
const landingFile = join(tmpdir(), "manicepte-trendyol-landing", "index.json");

const products = new ProductIndex();
let files = 0;
if (existsSync(productDir)) {
  for (const f of (await readdir(productDir)).filter((n) => n.endsWith(".json"))) {
    products.add(JSON.parse(await readFile(join(productDir, f), "utf8")) as SitemapProduct[]);
    files++;
  }
}
const landings: LandingEntry[] = existsSync(landingFile)
  ? JSON.parse(await readFile(landingFile, "utf8"))
  : [];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function card(p: IndexedProduct): string {
  // Trendyol'un kendi liste sayfalarinin kullandigi 400 px yeniden boyutlandirma yolu
  // (sitemap gorselleri 1200 px orijinal; liste JSON'unda "mnresize/400/-/" goruldu).
  const thumb = p.imageUrl?.replace(
    "https://cdn.dsmcdn.com/",
    "https://cdn.dsmcdn.com/mnresize/400/-/",
  );
  const img = thumb
    ? `<img src="${esc(thumb)}" alt="" loading="lazy">`
    : `<div class="noimg">görsel yok</div>`;
  return `<li>${img}<div><a href="${esc(p.productUrl)}" rel="nofollow noopener" target="_blank">${esc(p.title)}</a>
<div class="muted">Fiyat ve stok: Trendyol'da (bu kaynakta yok)</div></div></li>`;
}

function page(q: string): string {
  const t0 = performance.now();
  const hits = q ? products.search(q, 24) : [];
  const landing = q ? resolveLandings(landings, q, 1)[0] : undefined;
  const ms = (performance.now() - t0).toFixed(1);
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Trendyol dizin araması (araştırma)</title>
<style>:root{color-scheme:light dark}body{font:14px system-ui,sans-serif;max-width:860px;margin:16px auto;padding:0 16px;background:Canvas;color:CanvasText}
ul{padding:0}li{list-style:none;display:flex;gap:12px;margin:0 0 12px}img,.noimg{width:72px;height:72px;object-fit:contain;flex:none}.muted{opacity:.7;font-size:12px}</style></head>
<body><h1>Trendyol dizin araması (araştırma prototipi)</h1>
<p class="muted">Dizin: ${products.size.toLocaleString("tr-TR")} ürün (${files}/337 sitemap dosyası), ${landings.length.toLocaleString("tr-TR")} liste sayfası. Arama ${ms} ms. İstek anında Trendyol'a bağlanılmaz.</p>
<form><input name="q" value="${esc(q)}" size="40"> <button>Ara</button></form>
${landing ? `<p>Trendyol'da en uygun sayfa: <a href="https://www.trendyol.com${esc(landing.entry.path)}" rel="nofollow noopener" target="_blank">${esc(landing.entry.path)}</a></p>` : ""}
${q ? `<p>${hits.length} ürün</p><ul>${hits.map(card).join("")}</ul>` : ""}
</body></html>`;
}

createServer((req, res) => {
  const q = (new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "").slice(0, 120).trim();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(q));
}).listen(5179, "127.0.0.1", () => {
  process.stdout.write(
    `http://127.0.0.1:5179/  (${products.size} urun, ${landings.length} liste sayfasi)\n`,
  );
});
