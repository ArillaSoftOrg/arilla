/**
 * Yerel (modelsiz) sorgu analizi (0171 §5). Mevcut deterministik
 * ayristiricilari birlestirir; yeni NLP altyapisi YOK:
 * - `parseQueryText` (lexicon: renk, beden, marka, kategori, fiyat),
 * - `wordsOf` (sayi + birim birlestirme),
 * - katalog urun turu bas isimleri (`CATALOG_PRODUCT_TYPES`).
 *
 * Cikti, yonlendiricinin (route.ts) "yerel analiz yeterli mi?" kararini
 * verdigi sinyallerdir. Yazim duzeltme yapmaz (normalizasyonun isi); varsa
 * duzeltilmis metni (`corrected`) okur.
 */
import { CATALOG_PRODUCT_TYPES } from "../clarification/product-types.ts";
import { wordsOf } from "../search/fallback/analyze.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { foldForMatch } from "../search/text-match.ts";
import type { QueryFilters } from "../search/types.ts";
import type { NormalizedQueryLike } from "./normalized-query-adapter.ts";

export type LocalSignal =
  | "relation_marker"
  | "negation"
  | "accessory_with_device"
  | "unit_token"
  | "product_type_found"
  | "brand_found"
  | "budget_found";

export interface LocalAnalysis {
  tokenCount: number;
  explainedCount: number;
  /** Aciklanan token orani (0–1); bos sorguda 0. */
  coverage: number;
  productTypeId: string | null;
  filters: QueryFilters;
  signals: ReadonlySet<LocalSignal>;
}

/** Iliski isaretleri: baska bir seye gore tanimlanan istek ("X icin Y"). */
const RELATION_WORDS = new Set([
  "icin",
  "uyumlu",
  "uyumludur",
  "yerine",
  "gibi",
  "for",
  "compatible",
  "fits",
]);
/** Olumsuzluk: kelime olarak. "-siz/-suz" eki BILEREK yok ("kablosuz" bir ozelliktir). */
const NEGATION_WORDS = new Set([
  "olmayan",
  "olmasin",
  "olmasın",
  "degil",
  "haric",
  "harici",
  "without",
  "except",
  "non",
]);

/** Aksesuar/parca bas isimleri (katlanmis). Cihazla birlikte gecerse model gerekir. */
const ACCESSORY_HEADS = [
  "kilif",
  "kapak",
  "sarj",
  "kablo",
  "adaptor",
  "koruyucu",
  "kayis",
  "kordon",
  "ped",
  "yedek",
  "parca",
  "batarya",
  "pil",
  "stand",
  "tutucu",
  "case",
  "cover",
  "charger",
  "cable",
  "strap",
  "adapter",
  "protector",
  "replacement",
];
/** Cihaz isaretleri (katlanmis). */
const DEVICE_HEADS = [
  "telefon",
  "iphone",
  "galaxy",
  "samsung",
  "xiaomi",
  "redmi",
  "huawei",
  "laptop",
  "notebook",
  "macbook",
  "tablet",
  "ipad",
  "saat",
  "watch",
  "kulaklik",
  "airpods",
  "konsol",
  "playstation",
  "ps5",
  "xbox",
  "monitor",
  "televizyon",
  "tv",
  "phone",
];
const UNIT_RE = /^\d+(?:[.,]\d+)?(?:hz|inc|inch|inç|mah|w|gb|tb|mp|k)$/u;
const UNIT_WORDS = new Set(["hz", "inc", "inç", "inch", "mah", "watt"]);

function startsWithAny(word: string, heads: readonly string[]): boolean {
  return heads.some((head) => word.startsWith(head));
}

export function analyzeLocally(
  query: NormalizedQueryLike,
  lexicon: readonly LexiconEntry[],
): LocalAnalysis {
  const text = query.corrected;
  const words = wordsOf(text).filter((word) => word.length >= 2 || /\d/u.test(word));
  const signals = new Set<LocalSignal>();

  const parsed = parseQueryText(text, lexicon);
  const leftover = wordsOf(parsed.unparsed);
  let explained = Math.max(0, words.length - leftover.length);

  let productTypeId: string | null = null;
  for (const type of CATALOG_PRODUCT_TYPES) {
    const heads = type.head.map((head) => foldForMatch(head));
    if (words.some((word) => startsWithAny(word, heads))) {
      productTypeId = type.id;
      break;
    }
  }
  // Tur bas ismi ayristiricinin filtresine donusmediyse yine de "anlasildi" sayilir.
  if (productTypeId !== null) {
    const heads =
      CATALOG_PRODUCT_TYPES.find((t) => t.id === productTypeId)?.head.map(foldForMatch) ?? [];
    explained += leftover.filter((word) => startsWithAny(word, heads)).length;
  }
  if (productTypeId !== null || parsed.filters.category_path !== undefined) {
    signals.add("product_type_found");
  }
  if (parsed.filters.brand_include?.length) {
    signals.add("brand_found");
    // Markanin yanindaki model kodu ("samsung s24", "iphone 15") aciklanmis sayilir.
    explained += leftover.filter((word) => /\d/u.test(word)).length;
  }
  if (parsed.filters.price_min !== undefined || parsed.filters.price_max !== undefined) {
    signals.add("budget_found");
  }

  for (const word of words) {
    if (RELATION_WORDS.has(word)) signals.add("relation_marker");
    if (NEGATION_WORDS.has(word)) signals.add("negation");
    if (UNIT_RE.test(word) || UNIT_WORDS.has(word)) signals.add("unit_token");
  }
  const hasAccessory = words.some((word) => startsWithAny(word, ACCESSORY_HEADS));
  const hasDevice = words.some((word) => startsWithAny(word, DEVICE_HEADS));
  if (hasAccessory && hasDevice) signals.add("accessory_with_device");

  const tokenCount = words.length;
  explained = Math.min(explained, tokenCount);
  return {
    tokenCount,
    explainedCount: explained,
    coverage: tokenCount === 0 ? 0 : explained / tokenCount,
    productTypeId,
    filters: parsed.filters,
    signals,
  };
}
