/**
 * Canli testte (2026-10-12) dogrulanan iki magaza. Ikisi de arama sayfasini
 * `Access-Control-Allow-Origin: *` ile sunar; tarayici cerezsiz okuyabilir.
 * Veri yapilari resmi sozlesme degildir, haber vermeden degisebilir.
 */

import {
  decimalToKurus,
  flattenNextFlight,
  httpsUrlOn,
  isRecord,
  jsonValueAfter,
  scriptTextById,
} from "./parse-helpers.ts";
import type { LiveAvailability, LiveProduct, LiveStore } from "./types.ts";

function availabilityOf(raw: unknown): LiveAvailability {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s.endsWith("instock")) return "in_stock";
  if (s.endsWith("outofstock") || s.endsWith("soldout")) return "out_of_stock";
  return "unknown";
}

/**
 * Hepsiburada `/ara?q=`: `<script id="reduxStore">` ->
 * voltranState.fragmentsMap.*.ProductList.seoState.itemListElement (schema.org ItemList, JSON metni).
 */
export function extractHepsiburada(html: string, checkedAt: string): LiveProduct[] {
  const raw = scriptTextById(html, "reduxStore");
  if (!raw) return [];
  let items: unknown[] = [];
  try {
    const fragments = JSON.parse(raw)?.voltranState?.fragmentsMap ?? {};
    for (const fragment of Object.values(fragments) as unknown[]) {
      const list =
        isRecord(fragment) && isRecord(fragment.ProductList) ? fragment.ProductList : null;
      const text = list && isRecord(list.seoState) ? list.seoState.itemListElement : null;
      if (typeof text !== "string") continue;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        items = parsed.map((e) => (isRecord(e) && isRecord(e.item) ? e.item : e));
        break;
      }
    }
  } catch {
    return [];
  }

  const origin = "https://www.hepsiburada.com";
  const out: LiveProduct[] = [];
  for (const it of items) {
    if (!isRecord(it)) continue;
    const offer = isRecord(it.offers) ? it.offers : null;
    const priceKurus = decimalToKurus(offer?.price);
    const title = typeof it.name === "string" ? it.name.trim() : "";
    const productUrl = httpsUrlOn(it.url, origin, "hepsiburada.com");
    const images = Array.isArray(it.image) ? it.image : [it.image];
    const imageUrl =
      images.map((u) => httpsUrlOn(u, origin, "hepsiburada.net")).find(Boolean) ?? null;
    if (!title || !productUrl || !imageUrl || priceKurus === null || offer?.priceCurrency !== "TRY")
      continue;
    out.push({
      store: "hepsiburada",
      title,
      priceKurus,
      currency: "TRY",
      imageUrl,
      productUrl,
      merchant: "Hepsiburada",
      availability: availabilityOf(offer?.availability),
      lastCheckedAt: checkedAt,
    });
  }
  return out;
}

/**
 * CicekSepeti `/arama?query=`: Next.js akisi (`self.__next_f`) icindeki `"products":[...]`
 * (name, image, link, price.finalPrice). Listede stok ve satici yok.
 */
export function extractCiceksepeti(html: string, checkedAt: string): LiveProduct[] {
  const products = jsonValueAfter(flattenNextFlight(html), '"products":[');
  if (!Array.isArray(products)) return [];
  const origin = "https://www.ciceksepeti.com";
  const out: LiveProduct[] = [];
  for (const p of products) {
    if (!isRecord(p)) continue;
    const title = typeof p.name === "string" ? p.name.trim() : "";
    const priceKurus = decimalToKurus(isRecord(p.price) ? p.price.finalPrice : null);
    const link = typeof p.link === "string" ? `/${p.link.replace(/^\/+/, "")}` : null;
    const productUrl = link ? httpsUrlOn(link, origin, "ciceksepeti.com") : null;
    const imageUrl = httpsUrlOn(p.image, origin, "ciceksepeti.com");
    if (!title || !productUrl || !imageUrl || priceKurus === null) continue;
    // categoryTree: [{name:"Marketplace"},{name:"Spor ve Outdoor"},{name:"Spor Ayakkabı"},...]
    const categoryNames = (Array.isArray(p.categoryTree) ? p.categoryTree : [])
      .map((c) => (isRecord(c) && typeof c.name === "string" ? c.name : ""))
      .filter((n) => n && n !== "Marketplace");
    out.push({
      store: "ciceksepeti",
      title,
      priceKurus,
      currency: "TRY",
      imageUrl,
      productUrl,
      merchant: "ÇiçekSepeti",
      availability: "unknown",
      lastCheckedAt: checkedAt,
      ...(categoryNames.length > 0 ? { categoryNames } : {}),
    });
  }
  return out;
}

/**
 * Hepsiburada URUN sayfasindaki barkodlar (sayfa CORS'a acik, 2026-10-12): once urunun
 * `"gtin"`, sonra ayni sayfadaki varyant `"barcode"` degerleri (ornegin diger renkler).
 * Gecersiz uzunluk ve doldurma (`0000…`) barkodlar atlanir. Barkod urun kimligi DEGILDIR;
 * eslesme hedef magazanin urun sayfasinda baslikla ayrica dogrulanir.
 */
export function extractHepsiburadaGtins(html: string, limit = 6): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    if (!/^\d{8,14}$/.test(v) || /^0{4,}/.test(v) || out.includes(v)) return;
    out.push(v);
  };
  for (const m of html.matchAll(/\\?"gtin\\?"\s*:\s*\\?"(\d{8,14})\\?"/g)) push(m[1] as string);
  for (const m of html.matchAll(/\\?"barcode\\?"\s*:\s*\\?"(\d{8,14})\\?"/g)) push(m[1] as string);
  return out.slice(0, limit);
}

/**
 * HB arama sayfasi kategori faseti: reduxStore -> `VerticalFilter.html` icindeki
 * `"key":"AllCategories.CategoryId"` -> `values[].displayName`. Canli (2026-10-12) yalnizca
 * UST duzey ("Telefon", "Giyim / Ayakkabi", "Ev Elektronigi"); zayif kanit olarak kullanilir.
 */
export function extractHepsiburadaCategoryFacet(html: string, limit = 3): string[] {
  const raw = scriptTextById(html, "reduxStore");
  if (!raw) return [];
  try {
    const fragments = JSON.parse(raw)?.voltranState?.fragmentsMap ?? {};
    for (const fragment of Object.values(fragments) as unknown[]) {
      const vf =
        isRecord(fragment) && isRecord(fragment.VerticalFilter) ? fragment.VerticalFilter : null;
      if (!vf || typeof vf.html !== "string") continue;
      const at = vf.html.indexOf('"key":"AllCategories.CategoryId"');
      if (at < 0) continue;
      const values = jsonValueAfter(vf.html.slice(at), '"values":[');
      if (!Array.isArray(values)) continue;
      return values
        .map((v) => (isRecord(v) && typeof v.displayName === "string" ? v.displayName : ""))
        .filter(Boolean)
        .slice(0, limit);
    }
  } catch {
    /* bozuk durum: kanit yok */
  }
  return [];
}

export const LIVE_STORES: readonly LiveStore[] = [
  {
    id: "hepsiburada",
    origin: "https://www.hepsiburada.com",
    searchUrl: (q) => `https://www.hepsiburada.com/ara?q=${encodeURIComponent(q)}`,
    extract: extractHepsiburada,
    extractCategoryFacet: extractHepsiburadaCategoryFacet,
  },
  {
    id: "ciceksepeti",
    origin: "https://www.ciceksepeti.com",
    searchUrl: (q) => `https://www.ciceksepeti.com/arama?query=${encodeURIComponent(q)}`,
    extract: extractCiceksepeti,
  },
];
