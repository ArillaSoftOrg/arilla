/**
 * Trendyol'un kendi yayinladigi "arama kombinasyonu" sitemap'leri
 * (sitemap_search_combinations*.xml, sitemap_search_with_attributes*.xml)
 * marka/renk/cinsiyet/kategori/oznitelik filtreli ~340 bin liste sayfasi
 * adresi icerir; sitemap_brands.xml marka sayfalarini ekler. robots.txt bu
 * sayfalara izin verir. Bu dizin URUN verisi
 * degildir (fiyat/gorsel yok), yalnizca sorgu -> liste sayfasi yonlendirmesidir.
 */

import { isAccessoryText, tokenize, VARIANT_WORDS } from "./match.ts";

export interface LandingEntry {
  /** "/iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551" */
  path: string;
  words: string[];
  /** Facet ozeti (b=marka, r=renk, g=cinsiyet, c=kategori, a/v=oznitelik). */
  facets: string;
}

const LOC = /<loc>https:\/\/www\.trendyol\.com(\/[^<]+)<\/loc>/g;

export function parseLandingSitemap(xml: string): LandingEntry[] {
  const out: LandingEntry[] = [];
  for (const m of xml.matchAll(LOC)) {
    const path = m[1] ?? "";
    // "-x-" filtre sayfalari; "-y-s<id>" arama terimi acilis sayfalari
    // (sitemap_special_landing*.xml, ~95 bin; ornek: nike-air-force-1-y-s8056).
    const idx = Math.max(path.lastIndexOf("-x-"), path.lastIndexOf("-y-"));
    if (idx < 1 || path.includes("?")) continue;
    out.push({
      path,
      words: tokenize(path.slice(1, idx).replace(/-/g, " ")),
      facets: path.slice(idx + 3),
    });
  }
  return out;
}

export interface LandingCandidate {
  entry: LandingEntry;
  score: number;
  covered: string[];
}

/**
 * Sorguya en uygun liste sayfalari. Puan: kapsanan sorgu belirteci basina +10,
 * sorguda olmayan fazladan sozcuk basina -1. Sorguda olmayan varyant sozcugu
 * ("max") ve sorgu aksesuar degilse aksesuar sayfalari elenir.
 */
export function resolveLandings(
  index: LandingEntry[],
  query: string,
  limit = 3,
): LandingCandidate[] {
  const q = tokenize(query);
  const qset = new Set(q);
  const queryIsAccessory = isAccessoryText(query);
  const scored: LandingCandidate[] = [];
  for (const entry of index) {
    const covered = entry.words.filter((w) => qset.has(w));
    if (covered.length === 0) continue;
    if (entry.words.some((w) => VARIANT_WORDS.has(w) && !qset.has(w))) continue;
    // "iphone 16" sorgusuna "iphone-14-pro" sayfasi gelmesin: sayfadaki sayi sorguda olmali.
    if (entry.words.some((w) => /\d/.test(w) && !qset.has(w))) continue;
    if (!queryIsAccessory && isAccessoryText(entry.words.join(" "))) continue;
    const extra = entry.words.filter((w) => !qset.has(w)).length;
    scored.push({ entry, covered, score: new Set(covered).size * 10 - extra });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length);
  // Ayni sozcuk kumesine sahip yinelenen sayfalari tek tut.
  const seen = new Set<string>();
  const out: LandingCandidate[] = [];
  for (const c of scored) {
    const key = c.entry.words.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
