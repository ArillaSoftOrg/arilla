/**
 * Trendyol'un yayinladigi urun sitemap'lerinden (sitemap_products*.xml) urun
 * duzeyinde METADATA dizini. Kaynak Node'dan erisilebilir ve robots.txt ile
 * serbesttir; her urun icin yalnizca adres, marka/urun slug'i ve gercek CDN
 * gorseli vardir. FIYAT ve STOK YOKTUR; bunlar uydurulmaz (`price: null`).
 *
 * Bellek ici ters dizin: belirtec -> urun sira numaralari. Kalici depolama
 * gerektirmez; dizin yeniden kurulabilir bir onbellektir.
 */

import { isAccessoryText, matchProduct, tokenize } from "./match.ts";

export interface SitemapProduct {
  /** "apple/iphone-16-pro-128gb-col-titanyum-p-857296094" */
  path: string;
  imageUrl: string | null;
}

const URL_BLOCK = /<url>([\s\S]*?)<\/url>/g;
const LOC = /<loc>https:\/\/www\.trendyol\.com\/([^<]+)<\/loc>/;
const IMAGE = /<image:loc>(https:\/\/cdn\.dsmcdn\.com\/[^<]+)<\/image:loc>/;

export function parseProductSitemap(xml: string): SitemapProduct[] {
  const out: SitemapProduct[] = [];
  for (const m of xml.matchAll(URL_BLOCK)) {
    const block = m[1] ?? "";
    const path = LOC.exec(block)?.[1];
    if (!path || !/^[^/]+\/[^/?#]+-p-\d+$/.test(path)) continue;
    out.push({ path, imageUrl: IMAGE.exec(block)?.[1] ?? null });
  }
  return out;
}

/** Slug'dan okunabilir baslik. Turkce karakterler slug'da yoktur ("col" = "Çöl"). */
export function slugTitle(path: string): { brand: string; title: string } {
  const [brandSlug = "", rest = ""] = path.split("/");
  const words = (s: string) =>
    s
      .split("-")
      .filter(Boolean)
      .map((w) => (/^\d/.test(w) ? w.toUpperCase() : w[0]?.toUpperCase() + w.slice(1)));
  return {
    brand: words(brandSlug).join(" "),
    title: words(rest.replace(/-p-\d+$/, "")).join(" "),
  };
}

export interface IndexedProduct {
  title: string;
  brand: string;
  productUrl: string;
  imageUrl: string | null;
  /** Sitemap fiyat tasimaz; canli dogrulama olmadan her zaman null. */
  price: null;
  currency: null;
  availability: "unknown";
  source: "trendyol-product-sitemap";
  missing: string[];
}

export class ProductIndex {
  private readonly items: SitemapProduct[] = [];
  private readonly postings = new Map<string, number[]>();

  get size(): number {
    return this.items.length;
  }

  add(products: Iterable<SitemapProduct>): void {
    for (const p of products) {
      const id = this.items.length;
      this.items.push(p);
      for (const tok of new Set(tokenize(p.path.replace(/-p-\d+$/, "").replace(/[/-]/g, " ")))) {
        let list = this.postings.get(tok);
        if (!list) {
          list = [];
          this.postings.set(tok, list);
        }
        list.push(id);
      }
    }
  }

  /** Tum sorgu belirteclerini iceren urunler; varyant/durum/aksesuar korumasi uygulanir. */
  search(query: string, limit = 10): IndexedProduct[] {
    const q = [...new Set(tokenize(query))];
    if (q.length === 0) return [];
    const lists = q.map((t) => this.postings.get(t) ?? []);
    if (lists.some((l) => l.length === 0)) return [];
    lists.sort((a, b) => a.length - b.length);
    const [first, ...rest] = lists as [number[], ...number[][]];
    const restSets = rest.map((l) => new Set(l));
    const out: IndexedProduct[] = [];
    for (const id of first) {
      if (!restSets.every((s) => s.has(id))) continue;
      const item = this.items[id] as SitemapProduct;
      const { brand, title } = slugTitle(item.path);
      const plain = `${brand} ${title}`;
      if (!matchProduct(plain, query)) continue;
      if (!isAccessoryText(query) && isAccessoryText(plain)) continue;
      out.push({
        title: plain,
        brand,
        productUrl: `https://www.trendyol.com/${item.path}`,
        imageUrl: item.imageUrl,
        price: null,
        currency: null,
        availability: "unknown",
        source: "trendyol-product-sitemap",
        missing: ["price", "currency", "availability", ...(item.imageUrl ? [] : ["imageUrl"])],
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
