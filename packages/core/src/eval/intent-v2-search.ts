/**
 * Arama katmani olcumu, kosul (a) ve (b) (docs/decisions/0171 §10).
 *
 * (a) bugunku deterministik: `resolveQuery` + `/ara`'nin kademeli yolu.
 * (b) oracle niyet: AYNI ayristirma + altin etiketten uretilen plan
 *     (`planFromGold` -> `applyIntentPlan`). Fark yalnizca niyetin
 *     getirdigi filtrelerdir; R ipuclari siralamaya bagli degildir (Faz 2).
 *
 * Urun alakalilik etiketi YOK: bulma basarisi / nDCG burada hesaplanmaz,
 * uydurulmaz. Etiketsiz olculebilenler:
 * - sifir sonuc;
 * - butce ihlali (ilk 10'da etiket butcesi disinda fiyat);
 * - haric tutulan (oznitelik/marka) ilk 10 basliginda;
 * - uyumluluk kademesi dagilimi (yalniz uyumlu cihazli vakalar, bilgi);
 * - (a) ile (b) ilk 10 kesisimi.
 */
import { CATALOG_PRODUCT_TYPES } from "../clarification/product-types.ts";
import { intentCategoryFor } from "../intent/category-map.ts";
import { compatTier, type IntentSearchPlan } from "../intent/to-search.ts";
import type { SearchResultItem } from "../search/result-types.ts";
import { foldForMatch } from "../search/text-match.ts";
import type { IntentV2Case, IntentV2Gold } from "./intent-v2-eval.ts";

const fold = (value: string) => foldForMatch(value).trim();

export interface GoldPlanOptions {
  /**
   * Duzeltme oncesi davranis (karsilastirma icin): `product-types.ts` tur yolu
   * dogrudan kesin filtre olur.
   */
  legacyCategory?: boolean;
}

/** Altin etiket -> plan; uretim kurallariyla ayni kipler (0171 §4.2). */
export function planFromGold(gold: IntentV2Gold, options: GoldPlanOptions = {}): IntentSearchPlan {
  const filters: IntentSearchPlan["filters"] = {};
  if (gold.budget) {
    if (gold.budget[0] !== null) filters.price_min = Math.round(gold.budget[0] * 100);
    if (gold.budget[1] !== null) filters.price_max = Math.round(gold.budget[1] * 100);
  }
  if (gold.brand) filters.brand_include = [fold(gold.brand)];
  if (gold.exclude_brands.length > 0) filters.brand_exclude = gold.exclude_brands.map(fold);
  let hintCategory: string | null = null;
  if (options.legacyCategory) {
    const typePath =
      gold.role === "main" && gold.type_id
        ? (CATALOG_PRODUCT_TYPES.find((t) => t.id === gold.type_id)?.categoryPath ?? null)
        : null;
    // Eski etiketlerde gold.category her zaman bu yola esitti (eski veri seti testi).
    if (typePath) filters.category_path = typePath;
  } else if (gold.role === "main" && gold.type_id) {
    // Uretimdeki dogrulayiciyla ayni kural: yalniz dogrulanmis yol filtredir.
    const mapped = intentCategoryFor(gold.type_id);
    if (mapped?.hard) filters.category_path = mapped.hardPath;
    else if (mapped) hintCategory = mapped.hintPath;
  }

  const by = (strength: string) =>
    gold.attrs.filter((a) => a[2] === strength).map((a) => fold(a[1]));
  return {
    filters,
    hints: {
      role: gold.role,
      category: hintCategory,
      compatibleWith: gold.compat ? fold(gold.compat) : null,
      required: by("required"),
      preferred: by("preferred"),
      excluded: by("excluded"),
      brands: [],
    },
    display: [],
  };
}

/**
 * Sifir sonucun KURAL TABANLI nedeni (kesin kanit degil; insan dogrulamasi icin):
 * - `not_in_catalog`: kapsamdaki katalogda basligi etiketteki urun turunu
 *   (token onekleri) iceren urun yok;
 * - `filter`: boyle urun var ve AYNI metin filtresiz aranınca sonuc donuyor;
 * - `retrieval`: boyle urun var ama filtresiz arama da bulamiyor.
 */
export type ZeroCause = "not_in_catalog" | "filter" | "retrieval";

export function classifyZero(input: {
  catalogHasType: boolean;
  hadFilters: boolean;
  unfilteredReturned: number;
}): ZeroCause {
  if (!input.catalogHasType) return "not_in_catalog";
  if (input.hadFilters && input.unfilteredReturned > 0) return "filter";
  return "retrieval";
}

export interface ProbeTerm {
  /** Katlanmis kelime basi. */
  prefix: string;
  /** Kisa kelime (5 harften az): tam kelime olarak aranir ("kol" "kolye" degil). */
  whole: boolean;
}

/**
 * Urun turu metninden katalog yoklama terimleri: kelime BASINDA eslesir;
 * 5+ harfli kelimede ilk 5 harf (Turkce ek toleransi), kisa kelimede tam kelime.
 */
export function typeProbeTerms(text: string): ProbeTerm[] {
  return fold(text)
    .split(/[^\p{L}\d]+/u)
    .filter((token) => token.length >= 2)
    .map((token) =>
      token.length >= 5
        ? { prefix: token.slice(0, 5), whole: false }
        : { prefix: token, whole: true },
    );
}

export interface ConditionMetrics {
  /** Sifir sonucsa kural tabanli neden; degilse null. */
  zeroCause: ZeroCause | null;
  /** Sifir sonucta yoklamanin buldugu en fazla 3 ornek baslik (insan dogrulamasi). */
  probeTitles?: string[];
  returned: number;
  zero: boolean;
  stage: string;
  topIds: number[];
  /** Ilk 10'da fiyati etiket butcesi disinda olan urun sayisi (fiyatsiz sayilmaz). */
  budgetViolations: number;
  /** Ilk 10'da basliginda haric oznitelik ya da marka gecen urun sayisi. */
  excludedHits: number;
  /** Uyumlu cihazli vakada ilk 10'un kademe dagilimi [1,2,3]; degilse null. */
  compatTiers: [number, number, number] | null;
}

type Item = Pick<SearchResultItem, "productId" | "title" | "minPrice" | "brandName">;

export function measureItems(
  testCase: IntentV2Case,
  items: readonly Item[],
  stage: string,
  zeroCause: ZeroCause | null = null,
  probeTitles: string[] = [],
): ConditionMetrics {
  const gold = testCase.gold;
  const top = items.slice(0, 10);
  const min = gold.budget?.[0] ?? null;
  const max = gold.budget?.[1] ?? null;
  const budgetViolations = gold.budget
    ? top.filter(
        (i) =>
          i.minPrice !== null &&
          ((min !== null && i.minPrice < min * 100) || (max !== null && i.minPrice > max * 100)),
      ).length
    : 0;
  const excludedTerms = gold.attrs.filter((a) => a[2] === "excluded").map((a) => fold(a[1]));
  const excludedBrands = gold.exclude_brands.map(fold);
  const excludedHits = top.filter((i) => {
    const title = fold(i.title);
    const brand = i.brandName ? fold(i.brandName) : "";
    return (
      excludedTerms.some((t) => t.length > 0 && title.includes(t)) ||
      excludedBrands.some((b) => b.length > 0 && (brand === b || title.split(/\s+/).includes(b)))
    );
  }).length;
  let compatTiers: ConditionMetrics["compatTiers"] = null;
  if (gold.compat) {
    const tiers: [number, number, number] = [0, 0, 0];
    for (const i of top) {
      const tier = compatTier(i.title, gold.compat);
      tiers[tier - 1] = (tiers[tier - 1] ?? 0) + 1;
    }
    compatTiers = tiers;
  }
  return {
    zeroCause: items.length === 0 ? zeroCause : null,
    ...(items.length === 0 ? { probeTitles } : {}),
    returned: items.length,
    zero: items.length === 0,
    stage,
    topIds: top.map((i) => i.productId),
    budgetViolations,
    excludedHits,
    compatTiers,
  };
}

export interface IntentSearchRow {
  id: string;
  cat: string;
  /** Plan bos degilse true: (b) (a)'dan farkli girdiyle calisti. */
  planApplied: boolean;
  /** Etikette butce var. */
  hasBudget: boolean;
  /** Etikette haric oznitelik ya da marka var. */
  hasExcluded: boolean;
  a: ConditionMetrics;
  b: ConditionMetrics;
  overlap10: number;
}

export function overlap(a: readonly number[], b: readonly number[]): number {
  const set = new Set(a);
  return b.filter((id) => set.has(id)).length;
}

export interface IntentSearchSummary {
  cases: number;
  planApplied: number;
  zeroA: number;
  zeroB: number;
  /** Butceli vakalarda en az bir ihlal olan vaka sayisi. */
  budgetCases: number;
  budgetViolatedA: number;
  budgetViolatedB: number;
  excludedCases: number;
  excludedHitA: number;
  excludedHitB: number;
  compatCases: number;
  compatTier1A: number;
  compatTier1B: number;
  /** (b) ilk 10'u (a) ile tamamen ayni olan vaka. */
  identicalTop10: number;
  meanOverlap10: number;
  /** (a) sonuc verirken (b) sifir donen vaka: niyet filtresi asiri daraltti. */
  bEmptiedA: string[];
  zeroCausesA: Record<ZeroCause, number>;
  zeroCausesB: Record<ZeroCause, number>;
}

function causeCounts(metrics: readonly ConditionMetrics[]): Record<ZeroCause, number> {
  const out: Record<ZeroCause, number> = { not_in_catalog: 0, filter: 0, retrieval: 0 };
  for (const m of metrics) if (m.zeroCause) out[m.zeroCause] += 1;
  return out;
}

export function summarizeIntentSearch(rows: readonly IntentSearchRow[]): IntentSearchSummary {
  return {
    cases: rows.length,
    planApplied: rows.filter((r) => r.planApplied).length,
    zeroA: rows.filter((r) => r.a.zero).length,
    zeroB: rows.filter((r) => r.b.zero).length,
    budgetCases: rows.filter((r) => r.hasBudget).length,
    budgetViolatedA: rows.filter((r) => r.a.budgetViolations > 0).length,
    budgetViolatedB: rows.filter((r) => r.b.budgetViolations > 0).length,
    excludedCases: rows.filter((r) => r.hasExcluded).length,
    excludedHitA: rows.filter((r) => r.a.excludedHits > 0).length,
    excludedHitB: rows.filter((r) => r.b.excludedHits > 0).length,
    compatCases: rows.filter((r) => r.a.compatTiers !== null).length,
    compatTier1A: rows.reduce((s, r) => s + (r.a.compatTiers?.[0] ?? 0), 0),
    compatTier1B: rows.reduce((s, r) => s + (r.b.compatTiers?.[0] ?? 0), 0),
    identicalTop10: rows.filter(
      (r) =>
        r.a.topIds.length === r.b.topIds.length &&
        r.a.topIds.every((id, i) => r.b.topIds[i] === id),
    ).length,
    meanOverlap10: rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.overlap10, 0) / rows.length,
    bEmptiedA: rows.filter((r) => !r.a.zero && r.b.zero).map((r) => r.id),
    zeroCausesA: causeCounts(rows.map((r) => r.a)),
    zeroCausesB: causeCounts(rows.map((r) => r.b)),
  };
}
