/**
 * Katalog toplama sayfasinin kaynak magazaya baglanma izni (karar 0117) `connect-src`
 * basligindadir ve tarayici CSP'yi BELGE yuklenirken uygular. Panelden istemci tarafi
 * gecisle (next/link) gelinirse ilk yuklenen sayfanin CSP'si (`connect-src 'self'`) kalir
 * ve kaynak istegi tarayicida engellenir ("Failed to fetch"). Bu modul, sayfanin bu yolda
 * dogrudan yuklenip yuklenmedigini belirler; yuklenmediyse toplayici istek atmaz.
 */
export const COLLECTION_PAGE_PATH = "/yonetim/katalog/toplama";

/**
 * `navigationUrl`: `performance.getEntriesByType("navigation")[0].name` (belgenin ilk
 * yuklendigi adres). Bilinmiyorsa guvenli taraf: yuklenmemis sayilir.
 */
export function loadedAsDocumentAt(navigationUrl: string | undefined, path: string): boolean {
  if (!navigationUrl) return false;
  try {
    return new URL(navigationUrl).pathname.replace(/\/+$/, "") === path;
  } catch {
    return false;
  }
}

/** Tarayicida: bu belge toplama sayfasi olarak mi yuklendi (CSP izni gecerli mi)? */
export function collectionPageLoadedAsDocument(): boolean {
  if (typeof performance === "undefined") return false;
  const [nav] = performance.getEntriesByType("navigation");
  return loadedAsDocumentAt(nav?.name, COLLECTION_PAGE_PATH);
}

/**
 * Sayfa acilisinda otomatik yeniden yukleme karari. Yalniz gezinme kaydi VAR ve baska yolu
 * gosteriyorsa dogru: kayit yoksa (eski tarayici) yeniden yukleme dongusune girilmez; o durumda
 * baslatmadan once `collectionPageLoadedAsDocument` istegi yine engeller.
 */
export function needsReloadForCollection(navigationUrl: string | undefined): boolean {
  return Boolean(navigationUrl) && !loadedAsDocumentAt(navigationUrl, COLLECTION_PAGE_PATH);
}

export const RELOAD_REQUIRED_TEXT =
  "Bu sayfa panel içinden açıldığı için tarayıcı kaynak mağazaya bağlanma iznini (CSP) uygulamadı; istek atılmadı. Sayfa yeniden yükleniyor, ardından yeniden başlatın.";
