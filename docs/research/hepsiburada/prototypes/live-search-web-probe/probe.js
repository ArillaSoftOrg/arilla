// Eklentisiz canli arama yoklamasi. Ziyaretcinin tarayicisi, ManiCepte
// sayfasindan magazanin herkese acik arama sayfasini cerezsiz ister. Tarayici
// yaniti ancak magaza CORS ile izin verirse okutur; izin yoksa sonuc YOK.
// Engel asma, vekil sunucu, kimlik taklidi yok.

import { extractFromPage } from "../live-search-extension/extract.js";

const STORES = [
  {
    name: "Hepsiburada",
    origin: "https://www.hepsiburada.com",
    searchUrl: (q) => `https://www.hepsiburada.com/ara?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Trendyol",
    origin: "https://www.trendyol.com",
    searchUrl: (q) => `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`,
  },
];

function scriptsOf(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scripts = [...doc.querySelectorAll("script")];
  return {
    scriptTexts: scripts
      .filter((s) => !s.type || s.type === "text/javascript")
      .map((s) => s.textContent ?? ""),
    jsonLdTexts: scripts
      .filter((s) => s.type === "application/ld+json")
      .map((s) => s.textContent ?? ""),
    reduxStoreText: doc.getElementById("reduxStore")?.textContent ?? null,
  };
}

export async function probeStore(store, query) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(store.searchUrl(query), { mode: "cors", credentials: "omit" });
  } catch (e) {
    return {
      store: store.name,
      ok: false,
      reason: `tarayici okumaya izin vermedi (CORS): ${e.message}`,
    };
  }
  if (!res.ok) return { store: store.name, ok: false, reason: `HTTP ${res.status}` };
  const html = await res.text();
  const result = extractFromPage({
    ...scriptsOf(html),
    origin: store.origin,
    query,
    checkedAt: new Date().toISOString(),
  });
  return {
    store: store.name,
    ok: true,
    ms: Math.round(performance.now() - started),
    bytes: html.length,
    ...result,
  };
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function render(results) {
  const out = document.getElementById("out");
  out.replaceChildren(
    ...results.map((r) =>
      el("section", {}, [
        el("h2", { textContent: r.store }),
        r.ok
          ? el("p", {
              className: "muted",
              textContent: `${r.totalOnPage} sonuç, ${r.matchedCount} eşleşme · ${r.ms} ms · ${(r.bytes / 1e6).toFixed(1)} MB · ${r.source}`,
            })
          : el("p", { textContent: `Sonuç yok: ${r.reason}` }),
        el(
          "ul",
          {},
          (r.products ?? []).map((p) =>
            el("li", {}, [
              p.imageUrl
                ? el("img", { src: p.imageUrl, alt: "" })
                : el("span", { textContent: "görsel yok" }),
              el("div", {}, [
                el("a", {
                  href: p.productUrl,
                  target: "_blank",
                  rel: "nofollow noopener",
                  textContent: p.title,
                }),
                el("div", {
                  textContent: p.price ? `${p.price} ${p.currency}` : "fiyat doğrulanamadı",
                }),
                el("div", {
                  className: "muted",
                  textContent: `${p.availability} · ${p.lastCheckedAt}`,
                }),
              ]),
            ]),
          ),
        ),
      ]),
    ),
  );
  // Otomatik test icin okunabilir ozet.
  window.__probeResults = results;
}

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (q.length < 3) return;
  render(await Promise.all(STORES.map((s) => probeStore(s, q))));
});
