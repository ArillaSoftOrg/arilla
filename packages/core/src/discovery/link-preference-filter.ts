/**
 * Link aramasında tercih süzgeci (karar 0090) — saf fonksiyonlar, veritabanı yok.
 *
 * İlkeler:
 * - Yalnızca katalogda GERÇEKTEN bulunan alanlarla süzülür (`minPrice`,
 *   `product.color`, `product.attributes`). Özellik uydurulmaz.
 * - Bir tercih için aday havuzunda hiç veri yoksa tercih sessizce yok sayılmaz
 *   ve sonuçlar da süzülmez: `unapplied` ile bildirilir.
 * - Veri olan havuzda, verisi eksik aday tercihi SAĞLAMIŞ sayılmaz (elenir):
 *   fiyatı bilinmeyen ürünü "bütçeye uyuyor" diye göstermek yanıltıcı olur.
 * - "Aynı ürün" (GTIN/MPN kanıtlı) listesi bu dosyada hiç süzülmez; kimlik
 *   kanıtı tercihten bağımsızdır, uymayan tercih arayüzde görünür kalır.
 * - Alakasız ürünle doldurulmaz; az sonuç az döner.
 */
import type { LexiconEntry } from "../search/lexicon.ts";
import { findLexiconMatches } from "../search/lexicon.ts";
import { foldTurkish } from "../search/normalize.ts";
import { foldForMatch } from "../search/text-match.ts";
import type {
  LinkPreferenceKey,
  LinkPreferenceOutcome,
  LinkPreferences,
} from "./link-preferences.ts";

/** Katalogdan okunan, tercihin dayandığı alanlar. */
export interface CandidateFacts {
  productId: number;
  /** Kuruş. */
  minPrice: number | null;
  color: string | null;
  attributes: Record<string, unknown> | null;
  /** `category.path`; kategorisiz ürün null. */
  categoryPath: string | null;
}

/**
 * `product.attributes` içinde stil/malzeme taşıyan anahtarlar. Katalog şeması
 * anahtar adlarını sabitlemez (docs/schema.sql: "renk, malzeme, beden");
 * yalnızca bu adlar okunur, başka anahtardan çıkarım yapılmaz.
 */
export const STYLE_ATTRIBUTE_KEYS = ["style", "styles", "material", "materials"] as const;

function foldTerm(value: string): string {
  return foldForMatch(value).trim();
}

/**
 * İstenen etiketi ve sözlükte aynı `normalized`ı paylaşan yüzeyleri kapsar:
 * "siyah" ya da "black" fark etmeksizin katalogdaki kanonik değerle eşleşir.
 */
export function expandTerms(
  requested: readonly string[],
  lexicon: readonly LexiconEntry[],
  kinds: readonly LexiconEntry["kind"][],
): Set<string> {
  const terms = new Set<string>();
  const wanted = new Set(requested.map(foldTerm).filter(Boolean));
  for (const term of wanted) terms.add(term);
  for (const entry of lexicon) {
    if (!kinds.includes(entry.kind)) continue;
    const normalized = foldTerm(entry.normalized);
    const surface = foldTerm(entry.surface);
    if (wanted.has(normalized) || wanted.has(surface)) {
      terms.add(normalized);
      terms.add(surface);
    }
  }
  return terms;
}

/** `attributes` içindeki stil/malzeme değerleri (katlanmış, düz liste). */
export function styleValuesOf(attributes: Record<string, unknown> | null): string[] {
  if (!attributes) return [];
  const values: string[] = [];
  for (const key of STYLE_ATTRIBUTE_KEYS) {
    const raw = attributes[key];
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      if (typeof item === "string" && item.trim()) values.push(foldTerm(item));
    }
  }
  return values;
}

/**
 * Kaynak sayfanın serbest metin kategorisini katalog kategori yoluna çevirir.
 * Yeni eşleyici değil: arama ayrıştırıcısının kullandığı `category` sözlüğü.
 * Belirsizse null (yanlış eleme riski alınmaz): hiç eşleşme yok, ya da
 * eşleşen yollar tek bir hat üzerinde değil (ör. "Çanta" ve "Ayakkabı").
 * Hat üzerindeyse (ayakkabi, ayakkabi/sneaker) en geniş olan seçilir.
 */
export function resolveCategoryPath(
  sourceCategory: string | null,
  lexicon: readonly LexiconEntry[],
): string | null {
  if (!sourceCategory) return null;
  const categories = lexicon.filter((entry) => entry.kind === "category");
  if (categories.length === 0) return null;
  const text = foldTurkish(sourceCategory);
  const matches = findLexiconMatches(text, categories).sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  );
  const taken: { start: number; end: number }[] = [];
  const paths = new Set<string>();
  for (const match of matches) {
    if (taken.some((span) => match.start < span.end && span.start < match.end)) continue;
    taken.push({ start: match.start, end: match.end });
    paths.add(match.entry.normalized);
  }
  if (paths.size === 0) return null;
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const root = sorted[0];
  if (root === undefined) return null;
  const onOneChain = sorted.every((path) => path === root || path.startsWith(`${root}/`));
  return onOneChain ? root : null;
}

export function inCategory(categoryPath: string | null, wanted: string): boolean {
  return (
    categoryPath !== null && (categoryPath === wanted || categoryPath.startsWith(`${wanted}/`))
  );
}

/**
 * Kategori kapısı: yalnızca kategorisi BİLİNEN ve kaynağın kategorisinin
 * dışında kalan aday elenir; kategorisiz aday kalır (uyumsuzluk kanıtlanamaz).
 * Havuzda hiçbir aday o kategoride değilse kapı uygulanmaz: yol katalogda
 * karşılığı olmayan bir sözlük girdisi olabilir, hepsini elemek yanlış olur.
 */
export function applyCategoryGate<T extends { productId: number }>(
  items: readonly T[],
  facts: ReadonlyMap<number, CandidateFacts>,
  categoryPath: string | null,
): T[] {
  if (!categoryPath) return [...items];
  const anyInside = items.some((item) =>
    inCategory(facts.get(item.productId)?.categoryPath ?? null, categoryPath),
  );
  if (!anyInside) return [...items];
  return items.filter((item) => {
    const path = facts.get(item.productId)?.categoryPath ?? null;
    return path === null || inCategory(path, categoryPath);
  });
}

export interface PreferenceFilterInput<T extends { productId: number; score: number }> {
  /** Süzülecek "benzer" adaylar, skor sırasıyla. */
  similar: readonly T[];
  /** Süzülmeyen ama veri yeterliliği sayımına giren "aynı ürün" adayları. */
  same: readonly { productId: number }[];
  facts: ReadonlyMap<number, CandidateFacts>;
  preferences: LinkPreferences;
  colorTerms: ReadonlySet<string>;
  styleTerms: ReadonlySet<string>;
}

export interface PreferenceFilterResult<T> {
  similar: T[];
  outcome: LinkPreferenceOutcome;
}

export function applyPreferences<T extends { productId: number; score: number }>(
  input: PreferenceFilterInput<T>,
): PreferenceFilterResult<T> {
  const { preferences, facts } = input;
  const applied: LinkPreferenceKey[] = [];
  const unapplied: LinkPreferenceKey[] = [];
  const poolFacts = [...input.similar, ...input.same].flatMap((item) => {
    const fact = facts.get(item.productId);
    return fact ? [fact] : [];
  });

  const wantsPrice = preferences.priceMinKurus != null || preferences.priceMaxKurus != null;
  const wantsColor = (preferences.colors?.length ?? 0) > 0;
  const wantsStyle = (preferences.styles?.length ?? 0) > 0;

  const priceUsable = wantsPrice && poolFacts.some((fact) => fact.minPrice !== null);
  const colorUsable = wantsColor && poolFacts.some((fact) => fact.color !== null);
  const styleUsable =
    wantsStyle && poolFacts.some((fact) => styleValuesOf(fact.attributes).length > 0);

  if (wantsPrice) (priceUsable ? applied : unapplied).push("price");
  if (wantsColor) (colorUsable ? applied : unapplied).push("color");
  if (wantsStyle) (styleUsable ? applied : unapplied).push("style");

  const min = preferences.priceMinKurus ?? null;
  const max = preferences.priceMaxKurus ?? null;

  const kept = input.similar.filter((item) => {
    const fact = facts.get(item.productId);
    if (priceUsable) {
      const price = fact?.minPrice ?? null;
      if (price === null) return false;
      if (min !== null && price < min) return false;
      if (max !== null && price > max) return false;
    }
    if (colorUsable) {
      const color = fact?.color ? foldTerm(fact.color) : null;
      if (color === null || !input.colorTerms.has(color)) return false;
    }
    if (styleUsable) {
      const values = styleValuesOf(fact?.attributes ?? null);
      if (!values.some((value) => input.styleTerms.has(value))) return false;
    }
    return true;
  });

  let result = kept;
  if (preferences.sort === "cheapest") {
    // Süzülmüş uygun adaylar arasında; fiyatı bilinmeyen sona (skor sırası korunur).
    const price = (item: T) => facts.get(item.productId)?.minPrice ?? Number.POSITIVE_INFINITY;
    if (kept.some((item) => price(item) !== Number.POSITIVE_INFINITY)) {
      applied.push("sort");
      result = [...kept].sort((a, b) => {
        const pa = price(a);
        const pb = price(b);
        if (pa !== pb) return pa < pb ? -1 : 1;
        return b.score - a.score || a.productId - b.productId;
      });
    } else {
      unapplied.push("sort");
    }
  }

  return {
    similar: result,
    outcome: { applied, unapplied, droppedByPreferences: input.similar.length - kept.length },
  };
}
