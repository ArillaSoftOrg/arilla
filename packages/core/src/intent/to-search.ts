/**
 * Dogrulanmis IntentV2 -> mevcut arama girdisi (docs/decisions/0171 §7.1).
 *
 * Yeni arama algoritmasi YOK. Saf eslemedir; istek yoluna bagli degildir
 * (Faz 2 bayragi gelene kadar yalnizca degerlendirme kullanir).
 *
 * - H kipi -> mevcut `QueryFilters` (`price_min/max` kurus, `brand_include`,
 *   `brand_exclude`, `category_path`). H'ye giren her deger dogrulayicida
 *   katalog kolonuyla eslesmistir; burada yeniden H uretilmez.
 * - R kipi -> `RankHints`: siralama ipucu VERISI. Hicbir sonuc dislamaz.
 *   Kategori ipucu `applyIntentPlan`da `category_hint` olur (karar 0190: yumusak sinyal).
 * - D kipi -> `display`: yalnizca cip gosterimi.
 * - X -> atilir.
 *
 * Birlestirme (`applyIntentPlan`): oncelik kullanici > deterministik > model.
 * Deterministik ayristirmanin doldurdugu filtre ALANI ezilmez; yalnizca bos
 * alan doldurulur. Uyumlu cihazin markasi hicbir zaman `brand_include`a gitmez
 * (dogrulayici onu `compatible_with` alaninda tutar).
 */

import { foldForMatch } from "../search/text-match.ts";
import type { QueryFilters, QueryObject } from "../search/types.ts";
import type { IntentRole } from "./contract.ts";
import type { Criterion, ValidatedIntentV2 } from "./validate.ts";

export interface RankHints {
  role: IntentRole | null;
  /**
   * Uretimde dogrulanamamis tur kategorisi (`category-map.ts`): yalniz siralama
   * tercihi; kategorisiz ya da baska kategorideki urun DISLANMAZ.
   */
  category: string | null;
  /** Uyumlu cihaz metni (katlanmis); baslik kademesi icin (§4.3). */
  compatibleWith: string | null;
  required: string[];
  preferred: string[];
  /** Baslikta gecen urunu ALT siraya iter; dislamaz (§4.4). */
  excluded: string[];
  /** Duzeltmeden kabul edilen (R) marka; filtre degil. */
  brands: string[];
}

export interface IntentSearchPlan {
  filters: QueryFilters;
  hints: RankHints;
  display: Criterion[];
}

const fold = (value: string) => foldForMatch(value).trim();

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

export function toSearchPlan(intent: ValidatedIntentV2): IntentSearchPlan {
  const filters: QueryFilters = {};
  const hints: RankHints = {
    role: intent.downgraded ? null : intent.role,
    category: null,
    compatibleWith: null,
    required: [],
    preferred: [],
    excluded: [],
    brands: [],
  };
  const display: Criterion[] = [];

  for (const c of intent.criteria) {
    if (c.mode === "X") continue;
    if (c.mode === "D") {
      display.push(c);
      continue;
    }
    const value = c.canonical ?? fold(c.value);
    if (c.mode === "H") {
      switch (c.field) {
        case "brand":
          filters.brand_include = uniq([...(filters.brand_include ?? []), value]);
          break;
        case "excluded_brand":
          filters.brand_exclude = uniq([...(filters.brand_exclude ?? []), value]);
          break;
        case "category":
          if (c.canonical) {
            filters.category_path = c.canonical;
            // H kipi: dogrulayici katalog kolonuyla eslestirdi (karar 0171 §7.1, 0190).
            filters.category_source = "explicit_text_verified";
          }
          break;
        case "budget":
          // Deger `intent.budget`tan (kurus) okunur; asagida.
          break;
        default:
          // Dogrulayici baska alana H vermez; verirse sessizce filtre
          // uretilmez, ipucuna da cevrilmez (guvenli taraf).
          break;
      }
      continue;
    }
    // R kipi
    switch (c.field) {
      case "compatible_with":
        hints.compatibleWith = fold(c.value);
        break;
      case "category":
        hints.category = c.canonical;
        break;
      case "brand":
        hints.brands = uniq([...hints.brands, value]);
        break;
      case "attribute":
        if (c.strength === "excluded") hints.excluded = uniq([...hints.excluded, fold(c.value)]);
        else if (c.strength === "required") {
          hints.required = uniq([...hints.required, fold(c.value)]);
        } else hints.preferred = uniq([...hints.preferred, fold(c.value)]);
        break;
      default:
        break;
    }
  }

  const budgetIsHard = intent.criteria.some((c) => c.field === "budget" && c.mode === "H");
  if (budgetIsHard && intent.budget) {
    if (intent.budget.minKurus !== null) filters.price_min = intent.budget.minKurus;
    if (intent.budget.maxKurus !== null) filters.price_max = intent.budget.maxKurus;
  }
  return { filters, hints, display };
}

const isSet = (value: unknown) =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * Plan filtrelerini deterministik sorguya ekler; dolu alani EZMEZ.
 * `brand_exclude` istisnadir: dislama listeleri birlesir (her iki kaynak da
 * kullanicinin acik "olmasin" beyanidir).
 */
export function applyIntentPlan(base: QueryObject, plan: IntentSearchPlan): QueryObject {
  const merged: QueryFilters = { ...base.filters };
  const keys = ["category_path", "price_min", "price_max", "brand_include"] as const;
  for (const key of keys) {
    if (!isSet(merged[key]) && isSet(plan.filters[key])) {
      (merged as Record<string, unknown>)[key] = plan.filters[key];
      // Kategori kaynagi yoluyla birlikte gelir (karar 0190).
      if (key === "category_path" && plan.filters.category_source) {
        merged.category_source = plan.filters.category_source;
      }
    }
  }
  // R kipi kategori: yalniz siralama ipucu; kesin yol varsa eklenmez (karar 0190).
  if (isSet(merged.category_path) && isSet(merged.category_hint)) delete merged.category_hint;
  if (!isSet(merged.category_path) && !isSet(merged.category_hint) && plan.hints.category) {
    merged.category_hint = plan.hints.category;
  }
  if (isSet(plan.filters.brand_exclude)) {
    merged.brand_exclude = uniq([
      ...(merged.brand_exclude ?? []),
      ...(plan.filters.brand_exclude ?? []),
    ]);
  }
  const role = plan.hints.role;
  return role === null
    ? { ...base, filters: merged }
    : { ...base, filters: merged, product_role: role };
}

/** Uyumluluk kademesi (§4.3): 1 ust, 2 genel, 3 baska model. Dislama yok. */
export type CompatTier = 1 | 2 | 3;

/** Harf + rakam karisik kod ("s24", "a54", "13mini"). */
const MIXED_CODE = /^(?=.*\p{L})(?=.*\d)[\p{L}\d]+$/u;
const NUMBER = /^\d+$/u;

/**
 * Baslik istenen cihazin tum tokenlarini iceriyorsa 1; baska bir model
 * adliyorsa 3; hic model adlamiyorsa 2 (genel urun). Model adi: harf-rakam
 * karisik kod ya da istenen cihazin ilk tokenindan ("iphone") hemen sonra
 * gelen sayi. "2 adet", "1 m" gibi sayilar model sayilmaz.
 * Yalnizca SIRALAMA girdisidir; kesin uyumsuzluk karari degildir.
 */
export function compatTier(title: string, compatibleWith: string): CompatTier {
  const titleTokens = fold(title).split(/\s+/).filter(Boolean);
  const wanted = fold(compatibleWith).split(/\s+/).filter(Boolean);
  if (wanted.length > 0 && wanted.every((w) => titleTokens.includes(w))) return 1;
  const head = wanted[0];
  const namesModel = titleTokens.some(
    (t, i) =>
      MIXED_CODE.test(t) || (NUMBER.test(t) && head !== undefined && titleTokens[i - 1] === head),
  );
  return namesModel ? 3 : 2;
}
