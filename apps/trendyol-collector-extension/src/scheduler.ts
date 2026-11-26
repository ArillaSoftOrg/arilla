/**
 * Arka plan betigi (karar 0221, 0118'i degistirir). AG ISTEGI ATMAZ, kendiliginden uyanmaz.
 *
 * Tek isi: yonetim sayfasindaki zamanlayici (sayfa acik ve oturum gecerliyken; kota SUNUCUDA)
 * bir Trendyol adresi istediginde, adres toplanabilir bir urun/liste adresiyse ve kosu
 * silahliysa, bunu yoneticinin tarayicisinda TEK toplama sekmesinde acmak; kosu bitince o
 * sekmeyi kapatmak. Sayfayi icerik betigi (capture) her zamanki gibi okur. Icerik betikleri
 * sekme acamadigi ve yonetim sayfasi kullanici hareketi olmadan pencere acamadigi icin gerekir.
 *
 * Cerez/oturum okunmaz, istek yapilmaz, bot korumasi asilmaz: sayfalar yoneticinin kendi
 * tarayicisinda, normal gezinme olarak acilir. Hiz yonetim sayfasindadir.
 */
import { isCollectibleTrendyolUrl } from "@arilla/core/catalog-collection-trendyol-relay";
import { armedRunId, FINISH_KEY, NAV_KEY, TAB_KEY } from "./storage.ts";

async function collectorTab(): Promise<number | null> {
  const v = (await chrome.storage.local.get(TAB_KEY))[TAB_KEY];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

async function openInCollectorTab(url: string): Promise<void> {
  const existing = await collectorTab();
  if (existing != null) {
    try {
      await chrome.tabs.update(existing, { url });
      return;
    } catch {
      // Sekme kapatilmis: yenisi acilir.
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id != null) await chrome.storage.local.set({ [TAB_KEY]: tab.id });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const nav = changes[NAV_KEY]?.newValue as { runId?: unknown; url?: unknown } | undefined;
  if (nav && typeof nav.url === "string" && isCollectibleTrendyolUrl(nav.url)) {
    const url = nav.url;
    void (async () => {
      // Yalniz silahli (acik) kosunun istegi; baska kosuya ait eski istek acilmaz.
      if ((await armedRunId()) !== nav.runId) return;
      await openInCollectorTab(url);
    })();
  }
  if (changes[FINISH_KEY]?.newValue != null) {
    void (async () => {
      const tab = await collectorTab();
      await chrome.storage.local.remove([TAB_KEY, NAV_KEY]);
      if (tab != null) await chrome.tabs.remove(tab).catch(() => undefined);
    })();
  }
});
