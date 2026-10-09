/**
 * Ana sayfa -> yeni sekme mesaj aktarimi. Mesaj URL'ye, history'ye ya da
 * referrer'a GIRMEZ: ayni kaynakli `localStorage`a kisa omurlu, tek kullanimlik
 * bir kayit olarak yazilir; yalnizca rastgele bir nonce URL'de gider.
 * Okuyan taraf kaydi OKUR OKUMAZ siler (basari ya da hata fark etmez).
 */

export const BOOTSTRAP_PREFIX = "arilla:chat-boot:";
/** Kayit bundan eskiyse (terk edilmis sekme) yok sayilir ve silinir. */
export const BOOTSTRAP_TTL_MS = 60_000;
export const BOOTSTRAP_PATH = "/sohbet/yeni";

export interface BootstrapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BootstrapPayload {
  text: string;
  /** Epoch ms; gonderimden sekmeye gecikme olcumu icin (ham metin degil). */
  submittedAt: number;
  /**
   * Karar 0091: mesajin gorsel eki var. Gorselin kendisi BURADA degil, ayni nonce ile
   * IndexedDB'de (`chat-bootstrap-image.ts`); bu kayit yalnizca "gorsel bekle" isaretidir
   * ve sunucu istegi icin tekillestirme anahtarini tasir. Metin-only kayitta alan yoktur.
   */
  image?: { requestKey: string };
}

export function newNonce(random: () => number = Math.random): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `n${Date.now().toString(36)}${random().toString(36).slice(2, 12)}`;
}

export function bootstrapHref(nonce: string): string {
  return `${BOOTSTRAP_PATH}?n=${encodeURIComponent(nonce)}`;
}

/** Depolama kapali/dolu ise `false`; cagiran sekmeyi hic acmaz. */
export function stashBootstrap(
  storage: BootstrapStorage | null,
  nonce: string,
  payload: BootstrapPayload,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(`${BOOTSTRAP_PREFIX}${nonce}`, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Yazilmis ama hic kullanilmayacak kaydi siler (gorsel aktarimi basarisiz oldugunda). */
export function discardBootstrap(storage: BootstrapStorage | null, nonce: string): void {
  if (!storage) return;
  try {
    storage.removeItem(`${BOOTSTRAP_PREFIX}${nonce}`);
  } catch {
    // Silinemiyorsa TTL korur.
  }
}

/** Tek kullanimlik: bulunsa da bulunmasa da anahtari siler. */
export function takeBootstrap(
  storage: BootstrapStorage | null,
  nonce: string | null,
  now: number = Date.now(),
): BootstrapPayload | null {
  if (!storage || !nonce) return null;
  const key = `${BOOTSTRAP_PREFIX}${nonce}`;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  } finally {
    try {
      storage.removeItem(key);
    } catch {
      // Silinemiyorsa TTL korur.
    }
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<BootstrapPayload>;
    if (typeof value.text !== "string" || typeof value.submittedAt !== "number") return null;
    if (now - value.submittedAt > BOOTSTRAP_TTL_MS) return null;
    const requestKey = value.image?.requestKey;
    const image =
      typeof requestKey === "string" && requestKey.length >= 8 && requestKey.length <= 100;
    // Yalniz gorselli mesajda metin bos olabilir.
    if (value.text.trim() === "" && !image) return null;
    return image
      ? { text: value.text, submittedAt: value.submittedAt, image: { requestKey } }
      : { text: value.text, submittedAt: value.submittedAt };
  } catch {
    return null;
  }
}

/** Tarayici depolamasi; erisim bile hata verebilir (gizli pencere, engelleme). */
export function browserStorage(): BootstrapStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
