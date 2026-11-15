/**
 * Ana sayfa kipi (karar 0204): durum URL'dedir, böylece yenileme, geri/ileri ve giriş sonrası dönüş çalışır.
 *
 * - `/?s=<uuid>`  mevcut konuşma (girişli kullanıcı),
 * - `/?q=<sorgu>` arama turu (eski `/sohbet?q=`),
 * - `/?q=<sorgu>&g=1[&n=..]` misafir sohbeti (girişsiz; eski `/sohbet/misafir`),
 * - diğer her şey: bugünkü ana sayfa.
 *
 * Saf fonksiyonlar: sunucu sayfası, proxy ve testler aynı kuralı kullanır.
 */

export type HomeSearchParams = Record<string, string | string[] | undefined>;

export type HomeMode =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "guest" }
  | { kind: "conversation"; conversationId: string; sirala?: string; ac?: string }
  | { kind: "not_found" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `s` varsa konuşma (UUID değilse ya da sohbet kapalıysa 404), yoksa boş olmayan `q` arama turu.
 * `s` her zaman `q`dan önceliklidir.
 */
export function homeMode(params: HomeSearchParams, chatEnabled: boolean): HomeMode {
  const s = first(params.s);
  if (s !== undefined) {
    if (!chatEnabled || !UUID_RE.test(s)) return { kind: "not_found" };
    const sirala = first(params.sirala);
    const ac = first(params.ac);
    return {
      kind: "conversation",
      conversationId: s.toLowerCase(),
      ...(sirala !== undefined ? { sirala } : {}),
      ...(ac !== undefined ? { ac } : {}),
    };
  }
  const q = first(params.q);
  if (q !== undefined && q.trim() !== "") {
    return chatEnabled && first(params.g) === "1" ? { kind: "guest" } : { kind: "search" };
  }
  return { kind: "home" };
}

/** Sohbet/arama yüzeyi mi (sayfa gizli, dizinlenmez). */
export function isPrivateHomeMode(mode: HomeMode): boolean {
  return mode.kind !== "home";
}

/** `/?s=<id>` (+ korunan `sirala`, `ac`). */
export function homeConversationHref(
  conversationId: string,
  extra: { sirala?: string | undefined; ac?: string | undefined } = {},
): string {
  const params = new URLSearchParams({ s: conversationId });
  if (extra.sirala) params.set("sirala", extra.sirala);
  if (extra.ac) params.set("ac", extra.ac);
  return `/?${params.toString()}`;
}

/** `/?q=<sorgu>` arama turu adresi. */
export function homeSearchHref(query: string): string {
  return `/?${new URLSearchParams({ q: query }).toString()}`;
}

/** `/?q=<sorgu>&g=1&n=..` misafir sohbeti (adımlar `encodeInput` ile). */
export function homeGuestHref(query: string, steps: readonly string[] = []): string {
  const params = new URLSearchParams({ q: query, g: "1" });
  for (const step of steps) params.append("n", step);
  return `/?${params.toString()}`;
}
