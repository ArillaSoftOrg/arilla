/**
 * Fallback testleri icin bellek ici katalog ve `SearchProvider`. PostgreSQL
 * metin kapisinin davranisini taklit eder (bas isim eslesmeli, 3+ tokenli
 * sorguda bir niteleyici eksik olabilir) ama DB gerektirmez.
 *
 * Yalnizca testler icindir; `index.ts`ten disa acilmaz.
 */

import type { LexiconEntry } from "../lexicon.ts";
import { parseQueryText } from "../parse-query.ts";
import type { SearchResultItem } from "../result-types.ts";
import { allowedMisses, foldForMatch } from "../text-match.ts";
import type { QueryObject } from "../types.ts";
import { wordsOf } from "./analyze.ts";
import { wordSimilarity } from "./grade.ts";
import type { ProviderPage, SearchProvider, SearchQuery } from "./types.ts";

export interface CatalogProduct {
  id: number;
  title: string;
  brand: string | null;
  /** `category.path` */
  category: string;
  color?: string;
  /** Kurus. */
  price: number;
}

export const CATALOG: CatalogProduct[] = [
  {
    id: 1,
    title: "Apple iPhone 16 Pro Max 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "black",
    price: 7_500_000,
  },
  {
    id: 2,
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "black",
    price: 8_200_000,
  },
  {
    id: 3,
    title: "Apple iPhone 17 128GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "white",
    price: 6_400_000,
  },
  {
    id: 4,
    title: "Apple iPhone 16 128GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "white",
    price: 5_200_000,
  },
  {
    id: 5,
    title: "Apple AirPods Pro 2",
    brand: "Apple",
    category: "elektronik/kulaklik",
    price: 800_000,
  },
  {
    id: 6,
    title: "Nike Pegasus Koşu Ayakkabısı",
    brand: "Nike",
    category: "moda/ayakkabi/kosu",
    color: "red",
    price: 450_000,
  },
  {
    id: 7,
    title: "Nike Revolution Koşu Ayakkabısı",
    brand: "Nike",
    category: "moda/ayakkabi/kosu",
    color: "black",
    price: 300_000,
  },
  {
    id: 8,
    title: "Adidas Duramo Koşu Ayakkabısı",
    brand: "Adidas",
    category: "moda/ayakkabi/kosu",
    color: "red",
    price: 280_000,
  },
  {
    id: 9,
    title: "Nike Spor Çanta",
    brand: "Nike",
    category: "moda/canta",
    color: "black",
    price: 120_000,
  },
  {
    id: 10,
    title: "Samsung Galaxy S24 Ultra",
    brand: "Samsung",
    category: "elektronik/telefon",
    color: "black",
    price: 6_900_000,
  },
  // 2 numarayla ayni baslik: ayni urunun ikinci satiri (ornegin ayri icerik kaynagi).
  {
    id: 11,
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "black",
    price: 8_300_000,
  },
];

function toItem(product: CatalogProduct): SearchResultItem {
  return {
    productId: product.id,
    publicId: `p${product.id}`,
    slug: `urun-${product.id}`,
    title: product.title,
    primaryImageUrl: null,
    minPrice: product.price,
    brandName: product.brand,
    categoryPath: product.category,
    merchantTrustScore: 80,
    inStock: true,
    currentPercentile: 50,
    listPriceInflated: false,
    offerCount: 3,
    score: 0.5,
  };
}

function passesFilters(product: CatalogProduct, query: SearchQuery): boolean {
  const { filters } = query;
  if (filters.category_path) {
    const path = filters.category_path;
    if (product.category !== path && !product.category.startsWith(`${path}/`)) return false;
  }
  if (filters.color && filters.color.length > 0 && !filters.color.includes(product.color ?? "")) {
    return false;
  }
  if (filters.brand_include && filters.brand_include.length > 0) {
    if (!filters.brand_include.includes(foldForMatch(product.brand ?? ""))) return false;
  }
  if (filters.price_max != null && product.price > filters.price_max) return false;
  if (filters.price_min != null && product.price < filters.price_min) return false;
  return true;
}

/** Kapi: bas isim (son slot) eslesmeli, niteleyicilerden `allowedMisses` kadari eksik olabilir. */
function passesGate(product: CatalogProduct, query: SearchQuery): boolean {
  if (query.slots.length === 0) return true;
  const words = wordsOf(`${product.title} ${product.brand ?? ""}`);
  const threshold = query.fuzzy ? 0.7 : 0.9;
  const slotMatches = query.slots.map((slot) =>
    slot.some((alternative) =>
      alternative.split(" ").every((part) => wordSimilarity(part, words, "word") >= threshold),
    ),
  );
  const head = slotMatches[slotMatches.length - 1];
  const matched = slotMatches.filter(Boolean).length;
  return head === true && matched >= query.slots.length - allowedMisses(query.slots.length);
}

export interface RecordingProvider extends SearchProvider {
  calls: SearchQuery[];
}

export function createFakeProvider(
  catalog: readonly CatalogProduct[] = CATALOG,
): RecordingProvider {
  const calls: SearchQuery[] = [];
  return {
    name: "fake",
    calls,
    async search(query: SearchQuery): Promise<ProviderPage> {
      calls.push(query);
      const matching = catalog.filter(
        (product) => passesFilters(product, query) && passesGate(product, query),
      );
      return {
        items: matching.slice(query.offset, query.offset + query.limit).map(toItem),
        total: matching.length,
      };
    },
  };
}

/** Gercek ayristirici + (istege bagli) sozluk: UI'nin besledigi nesneyle ayni bicim. */
export function parsed(text: string, lexicon: readonly LexiconEntry[] = []): QueryObject {
  return parseQueryText(text, lexicon);
}

export const LEXICON: LexiconEntry[] = [
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
  { kind: "color", surface: "kırmızı", normalized: "red", weight: 1 },
  { kind: "color", surface: "mavi", normalized: "blue", weight: 1 },
  { kind: "category", surface: "koşu ayakkabısı", normalized: "moda/ayakkabi/kosu", weight: 1 },
];
