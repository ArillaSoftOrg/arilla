/**
 * Sorgu nesnesi. Uc giris noktasi (metin, gorsel, link) buraya cikar.
 * Sozlesme: docs/search.md.
 */

export type Intent = "exact" | "same_cheaper" | "similar_cheaper" | "browse";

export type Anchor =
  | { type: "product"; id: number }
  | { type: "image"; hash: string }
  | { type: "url"; value: string };

export type ColorNorm = "black" | "white" | "beige" | "ecru" | (string & {});

export type SortMode = "balanced" | "best_deal" | "closest_match";

/**
 * Kategori filtresinin kaynagi (karar 0190). `category_path` ile birlikte tasinir.
 * - `explicit_ui`: kullanici arayuzden/URL'den acikca secti -> kesin filtre, gevsetilmez.
 * - `explicit_text_verified`: kullanicinin metninden cikti ve sozluk/katalogla dogrulandi ->
 *   kesin filtre; dogrulama tutmazsa yumusak ipucuna (`category_hint`) duser.
 * Kaynagi bilinmeyen `category_path` (eski cagiran, eski onbellek) metin aramasinda bugunku
 * gibi kesin filtredir ama ACIK sayilmaz: anlamsal secicide `inferred` gibi davranir.
 * Tahmin edilen kategori `category_path`e YAZILMAZ; `category_hint`e yazilir.
 */
export type CategoryFilterSource = "explicit_ui" | "explicit_text_verified";

export interface QueryFilters {
  category_path?: string;
  category_source?: CategoryFilterSource;
  /**
   * Tahmin edilen kategori (model, IntentV2 R kipi, dogrulanamamis metin): yalniz siralama
   * sinyali. Hicbir urunu dislamaz; kategorisiz urun aday kalir (karar 0190).
   */
  category_hint?: string;
  color?: ColorNorm[];
  price_min?: number | null;
  price_max?: number | null;
  size_norm?: string;
  brand_include?: string[];
  brand_exclude?: string[];
  in_stock_only?: boolean;
  merchant_ids?: number[] | null;
}

export interface QueryObject {
  intent: Intent;
  anchor: Anchor | null;
  text: string;
  filters: QueryFilters;
  style_tags: string[];
  sort: SortMode;
  unparsed: string;
  confidence: number;
  /**
   * Metin kapisinin slotlari (docs/decisions/0029): `unparsed`in katlanmis
   * tokenlari, `synonym` sozluk satirlariyla genisletilmis. Her slot bir
   * alternatif listesi; son slot bas isimdir. Eski onbellek satirlarinda
   * yoktur — o zaman `unparsed` tokenlarindan uretilir.
   */
  text_slots?: string[][];
  /**
   * Dogrulanmis IntentV2 rolu (karar 0197): yalniz siralama; onbellege yazilmaz, `applyIntentPlan` ekler.
   * `accessory`/`part` ise ana urun aksesuar kademesi uygulanmaz.
   */
  product_role?: "main" | "accessory" | "part";
}
