import type { NewTabChatResult } from "./actions.ts";

/** Tarayıcıya bağımlı parçalar; testte sahte verilir. */
export interface TabHandle {
  location: { href: string };
  close(): void;
  document: { title: string; body: { textContent: string | null } };
  opener: unknown;
}

export interface OpenChatTabDeps {
  /** `window.open("", "_blank")`; engellenirse `null`. */
  open: () => TabHandle | null;
  /** Aynı sekmede gezinme (açılış engellendiğinde son çare). */
  navigate: (href: string) => void;
  start: (text: string) => Promise<NewTabChatResult>;
}

/**
 * Ana sayfa -> yeni sekmede sohbet. SIRA ÖNEMLİ: `open()` bu fonksiyonun İLK senkron
 * adımıdır; kullanıcı hareketi (Enter/tıklama) sürerken çağrılmalıdır, `await`ten sonra
 * açılan sekme popup engelleyiciye takılır. Sohbet oluşunca sekme hedefe gider; oluşmazsa
 * sekme KAPATILIR (boş sekme kalmaz) ve `false` döner. Ana sayfa sekmesine dokunulmaz.
 */
export async function openChatInNewTab(text: string, deps: OpenChatTabDeps): Promise<boolean> {
  const tab = deps.open();
  if (tab) {
    try {
      tab.document.title = "Sohbet açılıyor";
      tab.document.body.textContent = "Sohbet açılıyor…";
      tab.opener = null;
    } catch {
      // Sekme erişimi kısıtlıysa yalnızca yönlendirme yapılır.
    }
  }
  try {
    const result = await deps.start(text);
    if (result.status === "error") throw new Error("create failed");
    if (tab) tab.location.href = result.href;
    else deps.navigate(result.href);
    return true;
  } catch {
    tab?.close();
    return false;
  }
}
