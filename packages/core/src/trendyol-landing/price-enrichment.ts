/**
 * Fiyat zenginlestirme (arastirma prototipi). Urun kesfinden BAGIMSIZ:
 *   urun karti -> fiyat saglayicilari -> dogrulanmis teklif -> karta ekle
 * Kurallar:
 *  - Baska magazanin fiyati ASLA Trendyol fiyati olarak gosterilmez: `store`
 *    kartin magazasiyla ayni degilse teklif "trendyolPrice" olamaz.
 *  - Guvenilirligi dusuk eslesme gosterilmez; fiyat uydurulmaz.
 *  - Hicbir saglayici dogrulanmis fiyat vermezse kart "Fiyati magazada gor" der.
 * Saglayicilar (bkz. docs/research/trendyol-search/02-fiyat-zenginlestirme.md)
 * izin/anlasma gerektirir; bu dosya yalnizca sozlesmeyi ve eslestirme mantigini kurar.
 */

import { tokenize } from "./match.ts";

export interface ProductCard {
  store: "Trendyol";
  /** Trendyol urun kimligi ("857296094"). */
  storeProductId: string;
  title: string;
  productUrl: string;
}

export interface PriceQuote {
  /** Verinin geldigi kanal ("trendyol-direct", "akakce-partner" ...). */
  source: string;
  /** Teklifin ait oldugu magaza ("Trendyol", "Hepsiburada" ...). */
  store: string;
  /** Kaynak magaza urun kimligi biliniyorsa (en guclu eslesme). */
  storeProductId: string | null;
  /** Kaynaktaki teklif basligi. */
  title: string;
  seller: string | null;
  priceKurus: number;
  currency: string;
  checkedAt: string;
}

export interface PriceProvider {
  readonly name: string;
  quotes(card: ProductCard, signal?: AbortSignal): Promise<PriceQuote[]>;
}

export type Confidence = "exact" | "high" | "medium" | "low";

// Uretici kodlari: adidas ID0478/B75806, Nike CW2288-111, Apple MYNF3TU/A.
// Duz sayilar (fiyat, urun kimligi) kod sayilmaz.
const MODEL_CODE = /\b([a-z]{1,2}\d{4,5}(?:-?\d{3})?|[a-z0-9]{4,5}tu-?a)\b/g;

/** Basliktaki model/urun kodlari (ID0478, CW2288-111, MYNF3TU/A, B75806). */
export function modelCodes(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/[ı]/g, "i").replace(/\//g, "");
  return new Set([...norm.matchAll(MODEL_CODE)].map((m) => (m[1] ?? "").replace(/-/g, "")));
}

const STORAGE = /^\d+(gb|tb)$/;
const STOP = new Set(["apple", "turkiye", "garantili", "ve", "ile", "icin"]);

/**
 * Bir teklifin karttaki urunle eslesme guvenilirligi.
 * exact: ayni magaza + ayni urun kimligi. high: ortak model kodu.
 * medium: kart basligindaki anlamli belirteclerin tamami teklifte (depolama dahil).
 */
export function matchConfidence(card: ProductCard, quote: PriceQuote): Confidence {
  if (quote.store === card.store && quote.storeProductId === card.storeProductId) return "exact";
  const a = modelCodes(card.title);
  const b = modelCodes(quote.title);
  if ([...a].some((c) => b.has(c))) return "high";
  const qt = new Set(tokenize(quote.title));
  const ct = tokenize(card.title).filter((t) => !STOP.has(t));
  const storage = ct.filter((t) => STORAGE.test(t));
  if (storage.some((s) => !qt.has(s))) return "low";
  const covered = ct.filter((t) => qt.has(t)).length;
  return ct.length > 0 && covered / ct.length >= 0.8 ? "medium" : "low";
}

export interface EnrichedPrice {
  /** Yalnizca Trendyol'un kendi teklifinden; aksi halde null. */
  trendyolPrice: (PriceQuote & { confidence: Confidence }) | null;
  /** Ayni urunun baska magaza teklifleri (acikca baska magaza olarak etiketlenir). */
  otherStores: (PriceQuote & { confidence: Confidence })[];
  /** Kartta gosterilecek metin fiyat yoksa. */
  fallback: "Fiyatı mağazada gör" | null;
}

const RANK: Record<Confidence, number> = { exact: 3, high: 2, medium: 1, low: 0 };

export async function enrichPrice(
  card: ProductCard,
  providers: readonly PriceProvider[],
  opts: { minConfidence?: Confidence; maxAgeMs?: number; now?: () => number } = {},
): Promise<EnrichedPrice> {
  const min = RANK[opts.minConfidence ?? "medium"];
  const maxAge = opts.maxAgeMs ?? 24 * 3600 * 1000;
  const now = (opts.now ?? Date.now)();
  const all: (PriceQuote & { confidence: Confidence })[] = [];
  for (const p of providers) {
    let quotes: PriceQuote[] = [];
    try {
      quotes = await p.quotes(card);
    } catch {
      continue; // saglayici hatasi kartı bozmaz
    }
    for (const q of quotes) {
      if (!Number.isSafeInteger(q.priceKurus) || q.priceKurus <= 0 || q.currency !== "TRY")
        continue;
      const age = now - Date.parse(q.checkedAt);
      if (!(age >= 0 && age <= maxAge)) continue;
      const confidence = matchConfidence(card, q);
      if (RANK[confidence] < min) continue;
      all.push({ ...q, confidence });
    }
  }
  const byBest = (x: { confidence: Confidence; priceKurus: number }, y: typeof x) =>
    RANK[y.confidence] - RANK[x.confidence] || x.priceKurus - y.priceKurus;
  const own = all.filter((q) => q.store === card.store).sort(byBest);
  const others = all.filter((q) => q.store !== card.store).sort(byBest);
  return {
    trendyolPrice: own[0] ?? null,
    otherStores: others,
    fallback: own.length === 0 ? "Fiyatı mağazada gör" : null,
  };
}
