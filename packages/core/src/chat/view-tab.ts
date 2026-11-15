/**
 * Sohbet sonuç sekmesi (karar 0211): kullanıcının mesajı gönderdiği andaki AKTİF sekme.
 *
 * Sonuç cevabı (karar 0203) ürün gerçeklerini bu sekmenin sıralamasıyla okur; böylece cevapta
 * anılan ürünler ekrandaki kartlarla aynıdır. Tek doğruluk kaynağı burasıdır: web `parseSortKey`
 * ve `sortModeFor` bu işlevlere devreder (iki ayrı eşleme olmaz).
 */
import type { SortMode } from "../search/types.ts";
import type { SearchIntent } from "./contract.ts";

export type ChatViewTab = "secilen" | "firsat" | "eslesme";

export const CHAT_VIEW_TABS: readonly ChatViewTab[] = ["secilen", "firsat", "eslesme"];

/** İstemciden gelen ham değeri doğrular; tanımsız ya da bozuk değer `null`. */
export function parseViewTab(raw: unknown): ChatViewTab | null {
  return typeof raw === "string" && (CHAT_VIEW_TABS as readonly string[]).includes(raw)
    ? (raw as ChatViewTab)
    : null;
}

/**
 * Etkin sekme: açık tercih (`?sirala=`) varsa o; yoksa niyetin "daha uygun fiyatlı" isteği
 * fırsat/fiyat sekmesini açar. `eslesme` yalnız v2'de (metin aramada `closest_match` yoktur).
 */
export function resolveViewTab(
  raw: string | null | undefined,
  intent: Pick<SearchIntent, "sort">,
  options: { uxV2: boolean; closestMatchSupported?: boolean },
): ChatViewTab {
  if (raw === "firsat") return "firsat";
  if (raw === "secilen") return "secilen";
  if (raw === "eslesme" && (options.uxV2 || options.closestMatchSupported)) return "eslesme";
  return intent.sort === "cheapest" ? "firsat" : "secilen";
}

/** Sekmenin arama sıralaması (karar 0075; v2: karar 0202). */
export function sortModeForTab(tab: ChatViewTab, uxV2: boolean): SortMode {
  if (uxV2) {
    if (tab === "firsat") return "lowest_price";
    if (tab === "eslesme") return "best_match";
    return "balanced";
  }
  if (tab === "firsat") return "best_deal";
  if (tab === "eslesme") return "closest_match";
  return "balanced";
}

/**
 * Cevap gerçekleri için sıralama: metin aramasında `closest_match` yoktur (çapa ister), bu yüzden
 * v2 kapalıyken `eslesme` varsayılana düşer. Bu sekme zaten arayüzde pasiftir.
 */
export function factSortFor(tab: ChatViewTab, uxV2: boolean): SortMode {
  const sort = sortModeForTab(tab, uxV2);
  return sort === "closest_match" ? "balanced" : sort;
}
