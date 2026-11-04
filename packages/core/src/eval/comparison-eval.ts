/**
 * Turkce referansli karsilastirma sorgulari: bugunku davranisin olcumu
 * (Dupe arastirmasi sonrasi plan T2; roadmap R4, R6 icin kabul olcutu).
 *
 * "X'ten daha ucuz", "X'e benzer", "X gibi ama baska marka" sorgularinda
 * referans (anchor) bir SONUC FILTRESI degildir. Bu modul deterministik metin
 * ayristiricisinin (`parseQueryText`) bu sorgulara bugun ne yaptigini sayar:
 *
 * - Referans markasi zorunlu marka filtresine (`brand_include`) donusuyor mu?
 *   Bu, niyetin tersidir: "Dyson'dan ucuz" yalnizca Dyson gosterir.
 * - Karsilastirma sozcukleri ("daha", "ucuz", "benzer", "gibi", "muadili"...)
 *   metin aramasina zorunlu terim olarak kaliyor mu? Urun basliklarinda bu
 *   sozcukler olmadigi icin sonuc kumesi bosalir ya da bozulur.
 * - Iliski (cheaper/similar/...) taniniyor mu? Ayristirici bugun her zaman
 *   `intent: "browse"`, `anchor: null` uretir.
 * - Kontroller: duz marka filtresi ve "X olmasin" dislamasi korunuyor mu?
 *
 * Saf: sozluk disaridan gelir, veritabani ve model cagrisi yoktur.
 */
import { foldTurkish } from "../search/normalize.ts";
import type { QueryObject } from "../search/types.ts";

export type ComparisonRelation =
  | "cheaper"
  | "similar"
  | "similar_cheaper"
  | "same_cheaper"
  | "different_brand";

export const COMPARISON_RELATIONS: readonly ComparisonRelation[] = [
  "cheaper",
  "similar",
  "similar_cheaper",
  "same_cheaper",
  "different_brand",
];

export type ComparisonCategory = ComparisonRelation | "context" | "control";

export interface ComparisonGold {
  relation: ComparisonRelation | null;
  anchor: { kind: "product" | "brand_type" | "context"; text: string | null } | null;
  /** Referansin sorguda acikca yazili markasi; filtre DEGIL. */
  anchor_brand: string | null;
  product_type: string | null;
  /** Sonuc filtresi olmasi gereken markalar (yalnizca kontroller). */
  brand_include: string[];
  exclude_brands: string[];
}

export interface ComparisonCase {
  id: string;
  cat: ComparisonCategory;
  typo: boolean;
  q: string;
  gold: ComparisonGold;
}

export interface ComparisonDataset {
  label_source: string;
  lexicon_brands: string[];
  cases: ComparisonCase[];
}

/**
 * Karsilastirma isaretleri (katlanmis kok baslangici). Bir sorgunun kalan
 * metin terimlerinden biri bunlardan biriyle basliyorsa isaret aramaya
 * sizmistir. "uygun" kasitli olarak yok: "uygun fiyatli" kontrolde de gecer.
 */
export const COMPARISON_MARKER_STEMS = [
  "daha",
  "ucuz",
  "hesapl",
  "benze",
  "gibi",
  "muadil",
  "alternatif",
  "tarz",
  "yerine",
] as const;

export interface ComparisonCaseResult {
  id: string;
  cat: ComparisonCategory;
  /** Referans markasi `brand_include` oldu (yalnizca `anchor_brand` olan vakalar). */
  anchorBrandAsFilter: boolean | null;
  /** Zorunlu metin terimine donusen karsilastirma/fiyat isaretleri. */
  markersLeaked: string[];
  /** Ayristirici bir iliski/referans uretti (`intent` browse degil ya da `anchor` dolu). */
  relationRecognized: boolean;
  /** Altin dislamalarin hepsi `brand_exclude`'da (dislama yoksa null). */
  exclusionsKept: boolean | null;
  /** Kontrol vakasinda altin `brand_include` aynen korundu (yoksa null). */
  controlBrandKept: boolean | null;
}

export interface ComparisonSummary {
  cases: number;
  relationCases: number;
  controlCases: number;
  /** Referans markasi olan vakalarda, markanin zorunlu filtreye donusme orani (hedef 0). */
  anchorBrandAsFilterRate: number;
  /** Iliskili vakalarda, en az bir karsilastirma isaretinin aramaya sizma orani (hedef 0). */
  markerLeakRate: number;
  /** Iliskili vakalarda iliskinin taninma orani (hedef 1). */
  relationRecognizedRate: number;
  /** Acik dislama iceren vakalarda dislamanin korunma orani (hedef 1). */
  exclusionKeptRate: number;
  /** Marka filtreli kontrollerde filtrenin korunma orani (hedef 1). */
  controlBrandKeptRate: number;
  /** Kontrollerde yanlis iliski uretme orani (hedef 0). */
  controlFalseRelationRate: number;
  /**
   * Kontrollerde "ucuz" gibi bir tercih sozcugunun zorunlu metin terimi olarak
   * kalma orani (hedef 0; urun basliklarinda bu sozcukler gecmez).
   */
  controlMarkerLeakRate: number;
}

/** Kalan (filtreye cevrilmemis) metnin katlanmis terimleri. */
function remainingTerms(parsed: QueryObject): string[] {
  const slots = parsed.text_slots?.map((slot) => slot[0] ?? "") ?? [];
  const terms = slots.length > 0 ? slots : parsed.unparsed.split(/\s+/);
  return terms.map(foldTurkish).filter(Boolean);
}

export function scoreComparisonCase(
  testCase: ComparisonCase,
  parsed: QueryObject,
): ComparisonCaseResult {
  const { gold } = testCase;
  const include = (parsed.filters.brand_include ?? []).map(foldTurkish);
  const exclude = (parsed.filters.brand_exclude ?? []).map(foldTurkish);
  const hasRelation = gold.relation !== null;
  const markersLeaked = remainingTerms(parsed).filter((term) =>
    COMPARISON_MARKER_STEMS.some((stem) => term.startsWith(stem)),
  );
  return {
    id: testCase.id,
    cat: testCase.cat,
    anchorBrandAsFilter:
      gold.anchor_brand === null ? null : include.includes(foldTurkish(gold.anchor_brand)),
    markersLeaked,
    relationRecognized: parsed.intent !== "browse" || parsed.anchor !== null,
    exclusionsKept:
      gold.exclude_brands.length === 0
        ? null
        : gold.exclude_brands.every((brand) => exclude.includes(foldTurkish(brand))),
    controlBrandKept:
      hasRelation || gold.brand_include.length === 0
        ? null
        : gold.brand_include.every((brand) => include.includes(foldTurkish(brand))) &&
          !gold.brand_include.some((brand) => exclude.includes(foldTurkish(brand))),
  };
}

function rate(values: readonly boolean[]): number {
  return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
}

function defined<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

export function summarizeComparison(
  cases: readonly ComparisonCase[],
  results: readonly ComparisonCaseResult[],
): ComparisonSummary {
  const relationIds = new Set(cases.filter((c) => c.gold.relation !== null).map((c) => c.id));
  const relation = results.filter((r) => relationIds.has(r.id));
  const control = results.filter((r) => !relationIds.has(r.id));
  return {
    cases: results.length,
    relationCases: relation.length,
    controlCases: control.length,
    anchorBrandAsFilterRate: rate(defined(results.map((r) => r.anchorBrandAsFilter))),
    markerLeakRate: rate(relation.map((r) => r.markersLeaked.length > 0)),
    relationRecognizedRate: rate(relation.map((r) => r.relationRecognized)),
    exclusionKeptRate: rate(defined(results.map((r) => r.exclusionsKept))),
    controlBrandKeptRate: rate(defined(control.map((r) => r.controlBrandKept))),
    controlFalseRelationRate: rate(control.map((r) => r.relationRecognized)),
    controlMarkerLeakRate: rate(control.map((r) => r.markersLeaked.length > 0)),
  };
}
