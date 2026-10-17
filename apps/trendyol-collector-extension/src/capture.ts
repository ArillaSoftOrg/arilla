/**
 * Icerik betigi (https://www.trendyol.com/*): yonetici bir toplama kosusu actiysa ("arm") ve
 * sayfa urun/liste sayfasiysa, ACIK SAYFADA ZATEN BULUNAN veriyi okur ve yalniz eklenti
 * deposuna yazar. Ag istegi atmaz, gezinmez, tiklamaz; kosu yoksa hicbir sey yapmaz (karar 0118).
 */
import {
  captureTrendyolPage,
  enqueueCapture,
  isCollectibleTrendyolUrl,
} from "@arilla/core/catalog-collection-trendyol-relay";
import { ARMED_KEY, armedRunId, QUEUE_KEY, readQueue } from "./storage.ts";

async function captureOnce(): Promise<void> {
  if (!isCollectibleTrendyolUrl(location.href)) return;
  if ((await armedRunId()) == null) return;
  const captureId = crypto.randomUUID();
  const captured = captureTrendyolPage(document, location.href, new Date(), captureId);
  const { queue } = enqueueCapture(await readQueue(), captured);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

let lastHref = "";
async function onPage(): Promise<void> {
  if (location.href === lastHref) return;
  lastHref = location.href;
  await captureOnce();
}

void onPage();
// Sayfa ici gezinmede adres degisir ama gomulu veri eski kalabilir; cikarici adres ile gomulu
// kimligi karsilastirip eski veriyi reddeder (stale_embedded_data). Tam yuklemeler yine okunur.
window.addEventListener("popstate", () => void onPage());
chrome.storage.onChanged.addListener((changes, area) => {
  // Kosu acildiginda, zaten acik olan sayfa da bir kez okunur.
  if (area === "local" && ARMED_KEY in changes && changes[ARMED_KEY]?.newValue) {
    lastHref = "";
    void onPage();
  }
});
