import type { SearchIntent, SortMode } from "@arilla/core";

/**
 * Sohbet sonuç sekmeleri, mevcut arama sıralamalarına bağlanır (karar 0075);
 * ikinci bir sıralama motoru yoktur:
 *
 * - `secilen`  "Seçtiklerimiz"      -> `balanced`   (varsayılan)
 * - `firsat`   "En iyi fırsatlar"   -> `best_deal`
 * - `eslesme`  "En iyi eşleşmeler"  -> `closest_match`
 *
 * `closest_match` ürün çıpası (similarity_edge) ister; metin/sohbet aramasında çıpa
 * yoktur ve `search()` `UnsupportedSortForIntentError` atar. `/ara` da bu sekmeyi
 * metin aramasında devre dışı gösterir ("Bu arama için kullanılamıyor"); sohbet de aynısını yapar.
 */
export type ChatSortKey = "secilen" | "firsat" | "eslesme";

export const CLOSEST_MATCH_SUPPORTED = false;

export const CHAT_SORT_PARAM = "sirala";

/**
 * `uxV2` (karar 0202, `CHAT_UX_V2`): sekmeler Önerilenler / En Uygun Fiyat / En İyi Eşleşmeler;
 * `firsat` = `lowest_price`, `eslesme` = `best_match` (yalnız alaka). Kapalıyken bugünkü eşleme.
 */
export function parseSortKey(
  raw: string | undefined,
  intent: SearchIntent,
  uxV2 = false,
): ChatSortKey {
  if (raw === "firsat") return "firsat";
  if (raw === "secilen") return "secilen";
  if (raw === "eslesme" && (uxV2 || CLOSEST_MATCH_SUPPORTED)) return "eslesme";
  // Açık tercih yoksa niyetin "daha uygun fiyatlı" isteği fırsat sekmesini açar.
  return intent.sort === "cheapest" ? "firsat" : "secilen";
}

export function sortModeFor(key: ChatSortKey, uxV2 = false): SortMode {
  if (uxV2) {
    if (key === "firsat") return "lowest_price";
    if (key === "eslesme") return "best_match";
    return "balanced";
  }
  if (key === "firsat") return "best_deal";
  if (key === "eslesme") return "closest_match";
  return "balanced";
}

/** Arama turu (`/sohbet?q=`) bağlantısındaki `sort` değeri (varsayılan yazılmaz). */
export function araSortParam(key: ChatSortKey): "best_deal" | null {
  return key === "firsat" ? "best_deal" : null;
}
