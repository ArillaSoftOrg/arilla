/**
 * Sohbet blok düzeni v2 (karar 0200): saf yardımcılar. DB/React yok.
 */

/** Konuşmada aynı anda açılabilen ESKİ arama bloğu sayısı (ürün sorgusu maliyeti sınırı). */
export const MAX_OPEN_OLDER_BLOCKS = 2;
/** Açılan eski blokta gösterilen kart sayısı (en yeni blok 30). */
export const OLDER_BLOCK_RESULT_LIMIT = 6;
/** Değerlendirme metninden ÖNCE gösterilen ilk kart sayısı (karar 0201). */
export const COMMENTARY_HEAD_COUNT = 4;
/** Yeni blokta ilk görünen kart sayısı; devamı "Tüm N sonucu gör" ile. */
export const REVEAL_INITIAL_COUNT = 6;
/** Katalog + internet kartlarının sekme başına üst sınırı. */
export const CHAT_TAB_ITEM_CAP = 30;

/**
 * `?ac=12,8` -> geçerli arama mesajı sıraları. Tekrar, sayı olmayan, bilinmeyen sıra ve
 * sınırı aşan fazlalık atılır (en yeni istek korunur: listenin SONU).
 */
export function parseOpenSeqs(
  raw: string | undefined,
  validSeqs: ReadonlySet<number>,
  max: number = MAX_OPEN_OLDER_BLOCKS,
): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(",").slice(0, 20)) {
    if (!/^\d{1,9}$/.test(part)) continue;
    const seq = Number(part);
    if (validSeqs.has(seq) && !out.includes(seq)) out.push(seq);
  }
  return out.slice(-max);
}

/** Bir bloğu aç/kapa: yeni açılan sona eklenir, sınır aşılırsa en eski açık blok kapanır. */
export function toggleOpenSeqs(
  open: readonly number[],
  seq: number,
  max: number = MAX_OPEN_OLDER_BLOCKS,
): number[] {
  if (open.includes(seq)) return open.filter((value) => value !== seq);
  return [...open, seq].slice(-max);
}

/** `/sohbet/<id>?sirala=..&ac=..` (boş parametreler yazılmaz). */
export function openBlocksHref(
  conversationId: string,
  open: readonly number[],
  sirala?: string,
): string {
  const params = new URLSearchParams();
  if (sirala) params.set("sirala", sirala);
  if (open.length > 0) params.set("ac", open.join(","));
  const query = params.toString();
  return `/sohbet/${conversationId}${query ? `?${query}` : ""}`;
}

/** Katalog kartı sayısına göre internet kartlarına kalan yer (toplam <= `cap`). */
export function webCardLimit(catalogCount: number, cap: number = CHAT_TAB_ITEM_CAP): number {
  return Math.max(0, cap - catalogCount);
}

/** Kademeli gösterim: kaç kart görünür, düğme gerekli mi? */
export function revealPlan(
  total: number,
  expanded: boolean,
  initial: number = REVEAL_INITIAL_COUNT,
): { visible: number; needsButton: boolean } {
  const needsButton = total > initial;
  return { visible: expanded || !needsButton ? total : initial, needsButton };
}
