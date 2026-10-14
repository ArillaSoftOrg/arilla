// Sonuclari sekme bazinda, yalnizca tarayici oturumu boyunca tutar
// (chrome.storage.session: diske yazilmaz, tarayici kapaninca silinir).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "live-search-result" || sender.tab?.id == null) return;
  chrome.storage.session.set({ [`tab:${sender.tab.id}`]: { ...msg, at: Date.now() } });
  const n = msg.result?.products?.length ?? 0;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: n ? String(n) : "" });
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab:${tabId}`));
