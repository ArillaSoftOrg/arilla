import {
  type BootstrapStorage,
  bootstrapHref,
  newNonce,
  stashBootstrap,
} from "./chat-bootstrap.ts";

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
