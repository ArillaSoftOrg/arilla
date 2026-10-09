import {
  type BootstrapStorage,
  bootstrapHref,
  discardBootstrap,
  newNonce,
  stashBootstrap,
} from "./chat-bootstrap.ts";
import type { BootstrapImageStore } from "./chat-bootstrap-image.ts";

/** Tarayiciya bagimli parcalar; testte sahte verilir. */
export interface OpenChatTabDeps {
  /** `window.open(href, "_blank")`; engellenirse `null`. */
  open: (href: string) => unknown | null;
  /** Ayni sekmede gezinme (acilis engellendiginde son care). */
  navigate: (href: string) => void;
  storage: BootstrapStorage | null;
  now?: () => number;
  nonce?: () => string;
}

/**
 * Ana sayfa -> yeni sekmede sohbet. SIRA ONEMLI ve tamami SENKRON: mesaj tek
 * kullanimlik kayda yazilir, sonra `open()` kullanici hareketi (Enter/tiklama)
 * surerken cagrilir (await'ten sonra acilan sekme popup engelleyiciye takilir).
 * Sekme dogrudan gercek sohbet kabugu olan `/sohbet/yeni`yi acar (about:blank yok);
 * sohbeti sekme kendisi olusturur. Mesaj yazilamadiysa (depolama kapali) sekme
 * HIC acilmaz ve `false` doner. Popup engellenirse ayni sekmede gezinilir.
 */
export function openChatInNewTab(text: string, deps: OpenChatTabDeps): boolean {
  const nonce = (deps.nonce ?? newNonce)();
  const submittedAt = (deps.now ?? Date.now)();
  if (!stashBootstrap(deps.storage, nonce, { text, submittedAt })) return false;
  const href = bootstrapHref(nonce);
  const tab = deps.open(href);
  if (!tab) deps.navigate(href);
  return true;
}

export interface OpenChatTabImageDeps extends OpenChatTabDeps {
  /** IndexedDB deposu; yoksa ya da yazilamazsa cagiran ayni sekmede guvenli yola duser. */
  images: BootstrapImageStore | null;
  /** Gorsel yazilamazsa acilmis sekmeyi kapatir (bos sekme kalmasin). */
  closeTab?: (tab: unknown) => void;
}

/**
 * - `opened`: yeni sekmede sohbet kabugu acildi; gorsel IndexedDB'de, sekme bekliyor.
 * - `same_tab`: popup engellendi; ayni sekmede ayni kabuga gidildi (metinle ayni davranis).
 * - `fallback`: tasima yapilamadi (IndexedDB/localStorage yok ya da yazilamadi). Hicbir sekme
 *   acik kalmadi ve kayit temizlendi; cagiran mesaji AYNI sekmede dogrudan gonderir.
 *   Mesaj ya da gorsel sessizce kaybolmaz.
 */
export type OpenWithImageResult = "opened" | "same_tab" | "fallback";

/**
 * Metinle AYNI hat (karar 0091): once metin kaydi, sonra `open()` kullanici hareketi
 * surerken ve ilk `await`ten ONCE (popup engelleyici); gorsel Blob'u sekme yuklenirken
 * sonradan yazilir, sekme `waitForImage` ile bekler. Gorsel yazilamazsa sekme kapatilir ve
 * `fallback` doner.
 */
export async function openChatInNewTabWithImage(
  text: string,
  image: { blob: Blob; requestKey: string },
  deps: OpenChatTabImageDeps,
): Promise<OpenWithImageResult> {
  if (!deps.images) return "fallback";
  const nonce = (deps.nonce ?? newNonce)();
  const submittedAt = (deps.now ?? Date.now)();
  const stashed = stashBootstrap(deps.storage, nonce, {
    text,
    submittedAt,
    image: { requestKey: image.requestKey },
  });
  if (!stashed) return "fallback";
  const href = bootstrapHref(nonce);
  const tab = deps.open(href); // ilk await'ten once: kullanici hareketi hala gecerli

  const stored = await deps.images.put(nonce, image.blob, submittedAt);
  if (!stored) {
    discardBootstrap(deps.storage, nonce);
    if (tab) deps.closeTab?.(tab);
    return "fallback";
  }
  if (!tab) {
    deps.navigate(href);
    return "same_tab";
  }
  return "opened";
}
