const out = document.getElementById("out");
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const key = `tab:${tab?.id}`;
const data = (await chrome.storage.session.get(key))[key];

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

if (data) {
  const { result, query } = data;
  out.className = "";
  out.replaceChildren(
    el("p", {
      className: "muted",
      textContent: `"${query}": sayfada ${result.totalOnPage} ürün, ${result.matchedCount} eşleşme (${result.source})`,
    }),
    el(
      "ul",
      {},
      result.products.map((p) =>
        el("li", {}, [
          p.imageUrl
            ? el("img", { src: p.imageUrl, alt: "" })
            : el("span", { textContent: "görsel yok" }),
          el("div", {}, [
            el("a", {
              href: p.productUrl,
              target: "_blank",
              rel: "noopener",
              textContent: p.title ?? "(başlık yok)",
            }),
            el("div", {
              textContent: p.price ? `${p.price} ${p.currency}` : "fiyat doğrulanamadı",
            }),
            el("div", { className: "muted", textContent: `${p.merchant} · ${p.lastCheckedAt}` }),
          ]),
        ]),
      ),
    ),
  );
}
