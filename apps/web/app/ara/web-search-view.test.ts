import type { WebProductGroup, WebSearchOutcome } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultGrid } from "./search-results.tsx";
import { loadWebGroups } from "./web-search-section.tsx";
import { WebPendingItems, WebResultItems } from "./web-search-view.tsx";

const SUGGESTIONS = '<div class="container">Google</div>';

function group(over: Partial<WebProductGroup> & { key: string }): WebProductGroup {
  return {
    title: "Apple iPhone 15 Pro 256 GB",
    brand: "Apple",
    matchKind: "exact",
    minVerifiedPriceKurus: null,
    imageUrl: null,
    offers: [
      {
        id: `${over.key}-o`,
        seller: "magaza.com.tr",
        host: "magaza.com.tr",
        url: "https://www.magaza.com.tr/urun/iphone-15-pro",
        title: "Apple iPhone 15 Pro",
        priceKurus: null,
        priceStatus: "unverified",
        inStock: null,
      },
    ],
    ...over,
  };
}

const html = (groups: WebProductGroup[], suggestions: string | null = SUGGESTIONS) =>
  renderToStaticMarkup(
    createElement(ResultGrid, {
      items: [],
      extra: createElement(WebResultItems, { groups, suggestionsHtml: suggestions }),
    }),
  );

describe("unified result cards", () => {
  it("shows imaged and imageless products in one grid, with the real store name", () => {
    const out = html([
      group({ key: "a", imageUrl: "https://cdn.magaza.com.tr/a.jpg" }),
      group({ key: "b", title: "Apple iPhone 15 Pro Max" }),
    ]);
    expect(out.match(/<ul/g)?.length).toBe(1);
    expect(out).toContain("Apple · magaza.com.tr");
    expect(out).toContain("Fiyat mağazada");
    expect(out).toContain('src="https://cdn.magaza.com.tr/a.jpg"');
    expect(out.match(/<img/g)?.length).toBe(1);
    expect(out).toContain("iPhone 15 Pro Max");
  });

  it("has no separate web section, source badge or technical wording", () => {
    const out = html([group({ key: "a" })]);
    expect(out).not.toContain("İnternetten");
    expect(out).not.toContain("İnternetteki seçenekler");
    expect(out).not.toContain("<section");
  });

  it("renders Google Search Suggestions unmodified with the results", () => {
    const out = html([group({ key: "a" })]);
    expect(out).toContain("<iframe");
    expect(out).toContain("Google");
  });

  it("renders nothing without Search Suggestions (grounded results need them)", () => {
    expect(html([group({ key: "a" })], null)).not.toContain("magaza.com.tr");
  });

  it("never invents a price: verified price shown, unverified says it is at the store", () => {
    const out = html([
      group({
        key: "a",
        minVerifiedPriceKurus: 5_499_900,
      }),
      group({ key: "b" }),
    ]);
    expect(out).toContain("54.999");
    expect(out).toContain("Fiyat mağazada");
  });

  it("shows a store list for multi-store products and keeps direct sponsored links", () => {
    const base = group({ key: "a" });
    const two = group({
      key: "a",
      offers: [
        ...base.offers,
        { ...(base.offers[0] as WebProductGroup["offers"][number]), id: "x", seller: "diger.com" },
      ],
    });
    const out = html([two]);
    expect(out).toContain("2 mağaza");
    expect(out).toContain("diger.com");
    expect(out).toContain("nofollow noopener noreferrer sponsored");
  });

  it("pending items are skeletons plus a real status line", () => {
    const out = renderToStaticMarkup(createElement(WebPendingItems, {}));
    expect(out).toContain("Diğer mağazalarda da aranıyor");
    expect(out).toContain('aria-hidden="true"');
  });
});

describe("loadWebGroups states", () => {
  const bundle = (outcome: Partial<WebSearchOutcome> & Pick<WebSearchOutcome, "status">) => ({
    outcome: { groups: [], searchSuggestionsHtml: null, ...outcome },
    catalogHosts: new Set<string>(),
  });

  it("separates a failed search from zero products", async () => {
    expect((await loadWebGroups(Promise.resolve(bundle({ status: "error" })), [])).kind).toBe(
      "error",
    );
    expect((await loadWebGroups(Promise.resolve(bundle({ status: "unavailable" })), [])).kind).toBe(
      "error",
    );
    expect((await loadWebGroups(Promise.resolve(bundle({ status: "limited" })), [])).kind).toBe(
      "limited",
    );
    expect((await loadWebGroups(Promise.resolve(bundle({ status: "empty" })), [])).kind).toBe(
      "none",
    );
  });
});
