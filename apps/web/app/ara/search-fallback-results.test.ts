import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_DESCRIPTION,
  FALLBACK_LIST_HEADING,
  FALLBACK_TITLE,
  NO_RESULT_TITLE,
  SearchFallbackResults,
  SearchNoResults,
} from "./search-fallback-results.tsx";
import { ResultGrid } from "./search-results.tsx";

const items = [
  {
    productId: 2,
    slug: "iphone-17-pro",
    title: "Apple iPhone 17 Pro 256GB",
    primaryImageUrl: null,
    minPrice: 8_200_000,
    offerCount: 3,
    brandName: "Apple",
  },
];

describe("fallback UI labelling", () => {
  it("7. near results are labelled as fallback, never as plain results", () => {
    const html = renderToStaticMarkup(createElement(SearchFallbackResults, { items }));
    expect(html).toContain('data-search-mode="fallback"');
    expect(html).toContain(FALLBACK_TITLE);
    expect(html).toContain(FALLBACK_LIST_HEADING);
    expect(html).toContain("Apple iPhone 17 Pro 256GB");
    // "N sonuç" sayaci bu bolgede yok.
    expect(html).not.toMatch(/\d+\s+sonuç/);
  });

  it("normal results carry no fallback marker", () => {
    const html = renderToStaticMarkup(createElement(ResultGrid, { items }));
    expect(html).not.toContain("data-search-mode");
    expect(html).not.toContain(FALLBACK_TITLE);
  });

  it("empty state is distinct and shows no products", () => {
    const html = renderToStaticMarkup(createElement(SearchNoResults));
    expect(html).toContain('data-search-mode="empty"');
    expect(html).toContain(NO_RESULT_TITLE);
    expect(html).not.toContain("/urun/");
  });

  it("copy follows CLAUDE.md language rules", () => {
    const copy = [FALLBACK_TITLE, FALLBACK_DESCRIPTION, FALLBACK_LIST_HEADING].join(" ");
    expect(copy).not.toMatch(/satın al|dupe|ucuz/i);
    for (const word of copy.split(/\s+/).filter((w) => w.length > 2)) {
      expect(word).not.toBe(word.toLocaleUpperCase("tr-TR"));
    }
  });
});
