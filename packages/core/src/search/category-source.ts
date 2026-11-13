/**
 * Kategori kaynagi sozlesmesi (karar 0190). Saf: veritabani okumaz.
 *
 * | kaynak                   | metin aramasi                 | anlamsal secici | kategorisiz urun |
 * |--------------------------|-------------------------------|-----------------|------------------|
 * | `explicit_ui`            | kesin filtre, GEVSETILMEZ     | `explicit`      | dislanir         |
 * | `explicit_text_verified` | kesin filtre (ust kategoriye  | `explicit`      | dislanir         |
 * |                          | gevsetilebilir, karar 0066)   |                 |                  |
 * | `inferred`               | siralama ipucu, dislamaz      | `inferred`      | aday kalir       |
 * | `none`                   | kisit yok                     | kategori yok    | normal           |
 *
 * Kaynagi bilinmeyen `category_path` (eski cagiran ya da eski onbellek satiri) `legacy`dir:
 * metin aramasi bugunku gibi kesin filtre uygular (geriye uyum), ama ACIK sayilmaz.
 */
import { isSafeCategoryLiteral } from "./semantic/strategy.ts";
import type { CategoryFilterSource, QueryFilters } from "./types.ts";

export type CategorySource = CategoryFilterSource | "inferred" | "none";

export interface CategoryConstraint {
  /** Metin aramasinin uygulayacagi kesin yol (yoksa `null`). */
  hardPath: string | null;
  /** Yalniz siralama sinyali (yoksa `null`). */
  softPath: string | null;
  /** Kesin yolun kaynagi; kaynagi yazilmamis eski yol `legacy`. */
  source: CategorySource | "legacy";
  /** Fallback kategoriyi ust kategoriye gevsetebilir mi? */
  relaxable: boolean;
}

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === "string" && value !== "";

export function categoryConstraint(filters: QueryFilters): CategoryConstraint {
  const hint = nonEmpty(filters.category_hint) ? filters.category_hint : null;
  if (nonEmpty(filters.category_path)) {
    const source = filters.category_source ?? "legacy";
    return {
      hardPath: filters.category_path,
      // Kesin yol varken ipucu anlamsizdir (kesin yol zaten tum sonuclari o kategoriye sinirlar).
      softPath: null,
      source,
      relaxable: source !== "explicit_ui",
    };
  }
  if (hint !== null) return { hardPath: null, softPath: hint, source: "inferred", relaxable: true };
  return { hardPath: null, softPath: null, source: "none", relaxable: true };
}

/**
 * Anlamsal secicinin (karar 0189) kategori girdisi. Yalniz yazilmis acik kaynak `explicit` olur;
 * eski (`legacy`) yol ve ipucu `inferred`: secici onu kesin filtre saymaz.
 */
export function selectorCategory(
  filters: QueryFilters,
): { path: string; source: "explicit" | "inferred" } | null {
  const c = categoryConstraint(filters);
  if (c.hardPath !== null) {
    const explicit = c.source === "explicit_ui" || c.source === "explicit_text_verified";
    return { path: c.hardPath, source: explicit ? "explicit" : "inferred" };
  }
  if (c.softPath !== null) return { path: c.softPath, source: "inferred" };
  return null;
}

/** Kesin yolu ipucuna cevirir (dogrulama tutmadi ya da kaynak tahmin). */
export function downgradeCategoryToHint(filters: QueryFilters): QueryFilters {
  const { category_path, category_source: _source, ...rest } = filters;
  if (!nonEmpty(category_path)) return rest;
  return { ...rest, category_hint: category_path };
}

/** Tahmin edilen kategoriyi ekler; kesin yol ya da onceki ipucu varsa dokunmaz. */
export function withCategoryHint(
  filters: QueryFilters,
  path: string | null | undefined,
): QueryFilters {
  if (!nonEmpty(path ?? undefined)) return filters;
  if (nonEmpty(filters.category_path) || nonEmpty(filters.category_hint)) return filters;
  return { ...filters, category_hint: path as string };
}

/** Kullanicinin arayuzde sectigi kategori: her zaman metin/tahmin kategorisini ezer. */
export function withExplicitUiCategory(filters: QueryFilters, path: string): QueryFilters {
  const { category_hint: _hint, ...rest } = filters;
  return { ...rest, category_path: path, category_source: "explicit_ui" };
}

/** URL parametresi `kategori`: yalniz guvenli yol bicimi; katalogda varligi ayrica denetlenir. */
export function parseUiCategoryParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return isSafeCategoryLiteral(trimmed) ? trimmed : null;
}

/**
 * Metin kaynakli kesin yolu katalogla dogrular (karar 0190 "guvenli geri donus"): yol kategori
 * agacinda yoksa kesin filtre olmaz, ipucuna duser. `explicit_ui` dogrulamasi cagiranindir (URL
 * parametresi gecersizse hic eklenmez). Eski (`legacy`) yola dokunulmaz.
 */
export function verifyTextCategory(
  filters: QueryFilters,
  knownPaths: ReadonlySet<string> | null,
): QueryFilters {
  if (filters.category_source !== "explicit_text_verified" || !nonEmpty(filters.category_path)) {
    return filters;
  }
  // Agac okunamadiysa bugunku davranis korunur (sozluk zaten dogrulanmis kaynaktir).
  if (knownPaths === null) return filters;
  return knownPaths.has(filters.category_path) ? filters : downgradeCategoryToHint(filters);
}
