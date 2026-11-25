/**
 * Arka plan zamanlayicisi (karar 0221, 0118'i degistirir). AG ISTEGI ATMAZ.
 *
 * Yalniz iki sey yapar:
 *  1. Saatlik alarmda, yonetim sayfasinin biraktigi "sonraki yoklama" zamani gelmisse ManiCepte
 *     yonetim sayfasini (`ADMIN_SCHEDULE_URL`, sabit) arka planda bir sekmede acar. Koşunun
 *     baslatilip baslatilmayacagina SUNUCU karar verir (kota: en az 7 gun, ayda 4).
 *  2. Yonetim sayfasi zamanlanmis koşuda bir Trendyol adresi istediginde, adres toplanabilir bir
 *     urun/liste adresiyse ve koşu silahliysa, bunu yoneticinin tarayicisinda TEK toplama
 *     sekmesinde acar. Sayfayi icerik betigi (capture) her zamanki gibi okur.
 *
 * Cerez/oturum okunmaz, istek yapilmaz, bot korumasi asilmaz: sayfalar yoneticinin kendi
 * tarayicisinda, kendi oturumuyla, normal gezinme olarak acilir. Hiz yonetim sayfasindadir
 * (`paceDelayMs`, en az 20 sn + rastgele).
 */
import { isCollectibleTrendyolUrl } from "@arilla/core/catalog-collection-trendyol-relay";
import { armedRunId, FINISH_KEY, HINT_KEY, NAV_KEY, TAB_KEY } from "./storage.ts";

declare const __ADMIN_SCHEDULE_URL__: string;
const ADMIN_SCHEDULE_URL = __ADMIN_SCHEDULE_URL__;
const ALARM = "manicepte-schedule-tick";
/** Sayfa hic ipucu birakmazsa (oturum kapali, eklenti bagli degil) yeniden deneme araligi. */
const FALLBACK_MS = 6 * 60 * 60 * 1000;

function ensureAlarm(): void {
  chrome.alarms.create(ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void (async () => {
    // Koşu surerken yonetim sayfasi ipucunu ileri tasir; yarim kalan koşuyu sayfa kapatir.
    const raw = (await chrome.storage.local.get(HINT_KEY))[HINT_KEY];
    const hint = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    const now = Date.now();
    if (!Number.isNaN(hint) && now < hint) return;
    // Sayfa yeni ipucu birakana dek tekrar acmamak icin once ileri al.
    await chrome.storage.local.set({ [HINT_KEY]: new Date(now + FALLBACK_MS).toISOString() });
    await chrome.tabs.create({ url: ADMIN_SCHEDULE_URL, active: false });
  })();
});

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
