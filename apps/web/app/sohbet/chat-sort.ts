import {
  type ChatViewTab,
  resolveViewTab,
  type SearchIntent,
  type SortMode,
  sortModeForTab,
} from "@arilla/core";

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
export type ChatSortKey = ChatViewTab;

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
  // Karar 0211: eşleme çekirdektedir (cevap gerçekleri de aynı kuralla sekmeyi çözer).
  return resolveViewTab(raw, intent, { uxV2, closestMatchSupported: CLOSEST_MATCH_SUPPORTED });
}

export function sortModeFor(key: ChatSortKey, uxV2 = false): SortMode {
  return sortModeForTab(key, uxV2);
}

/** Arama turu (`/sohbet?q=`) bağlantısındaki `sort` değeri (varsayılan yazılmaz). */
export function araSortParam(key: ChatSortKey): "best_deal" | null {
  return key === "firsat" ? "best_deal" : null;
}

/** Karar 0211: sonuç cevabının dayandığı sekmenin adı (v2 adları / mevcut adlar). */
export function answerBasisLabel(
  key: ChatSortKey,
  uxV2: boolean,
  copy: { selected: string; deals: string; matches: string; v2: [string, string, string] },
): string {
  if (uxV2) return key === "firsat" ? copy.v2[1] : key === "eslesme" ? copy.v2[2] : copy.v2[0];
  return key === "firsat" ? copy.deals : key === "eslesme" ? copy.matches : copy.selected;
}
