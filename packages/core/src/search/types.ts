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

export interface QueryFilters {
  category_path?: string;
  color?: ColorNorm[];
  price_min?: number | null;
  price_max?: number | null;
  /**
   * `price_min`/`price_max` para birimi. Yalnizca TRY (CLAUDE.md); alan yoksa TRY
   * varsayilir (eski onbellek satirlari). Ayristirici bir fiyat siniri koydugunda yazar.
   */
  currency?: "TRY";
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
   * Onbellege yazilirken `resolveQuery` damgasi (`QUERY_PARSER_VERSION`). Ayristirici
   * koymaz; yoksa satir 1. surum sayilir ve bir sonraki okumada yenilenir (karar 0070).
   */
  parser_version?: number;
}
