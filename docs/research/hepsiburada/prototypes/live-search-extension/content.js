// Icerik betigi: yalnizca kullanicinin KENDI actigi arama sayfasinda calisir.
// Ag istegi atmaz, sayfada gezinmez, tiklamaz; sayfadaki <script> metinlerini
// okur ve sonucu yalnizca bu sekme icin chrome.storage.session'a yazar.
// Hicbir veri ManiCepte sunucusuna gonderilmez (prototip).

(async () => {
  const { extractFromPage } = await import(chrome.runtime.getURL("extract.js"));
  const url = new URL(location.href);
  const query = url.searchParams.get("q") ?? "";
  if (!query.trim()) return;

  const scripts = [...document.querySelectorAll("script")];
  const result = extractFromPage({
    scriptTexts: scripts
      .filter((s) => !s.type || s.type === "text/javascript")
      .map((s) => s.textContent ?? ""),
    jsonLdTexts: scripts
      .filter((s) => s.type === "application/ld+json")
      .map((s) => s.textContent ?? ""),
    reduxStoreText: document.getElementById("reduxStore")?.textContent ?? null,
    origin: url.origin,
    query,
    checkedAt: new Date().toISOString(),
  });
  await chrome.runtime.sendMessage({
    type: "live-search-result",
    query,
    pageUrl: url.href,
    result,
  });
})();
