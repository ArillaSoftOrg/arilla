import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { loadRecentSearchChips, toRecentSearchChips } from "./home-recent-searches.ts";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";

const TITLE = "Alışverişe devam et";
const at = new Date("2026-03-01T10:00:00.000Z");

function render(recentSearches?: ReturnType<typeof toRecentSearchChips>) {
  return renderToStaticMarkup(createElement(HomeSearchComposer, { recentSearches }));
}

describe("toRecentSearchChips", () => {
  it("sırayı korur ve /ara?q= bağlantısı üretir (kodlanmış)", () => {
    const chips = toRecentSearchChips([
      { queryNorm: "beyaz sneaker", searchedAt: at },
      { queryNorm: "a&b=c ?", searchedAt: at },
    ]);
    expect(chips).toEqual([
      { label: "beyaz sneaker", href: "/ara?q=beyaz%20sneaker" },
      { label: "a&b=c ?", href: "/ara?q=a%26b%3Dc%20%3F" },
    ]);
  });

  it("boş geçmiş boş liste verir", () => {
    expect(toRecentSearchChips([])).toEqual([]);
  });
});

describe("loadRecentSearchChips", () => {
  it("misafir için veritabanına gitmeden boş döner", async () => {
    expect(await loadRecentSearchChips(null)).toEqual([]);
  });
});

describe("ana sayfa 'Alışverişe devam et' bölümü", () => {
  it("geçmiş yok -> bölüm, başlık ve liste hiç çizilmez", () => {
    for (const html of [render(undefined), render([])]) {
      expect(html).not.toContain(TITLE);
      expect(html).not.toContain("<ul");
    }
  });

  it("geçmiş dolu -> başlık ve gerçek kayıtlar, en yeni önce, bağlantı olarak", () => {
    const html = render(
      toRecentSearchChips([
        { queryNorm: "masa lambasi", searchedAt: at },
        { queryNorm: "bel cantasi", searchedAt: at },
      ]),
    );
    expect(html).toContain(TITLE);
    expect(html.indexOf("masa lambasi")).toBeGreaterThan(-1);
    expect(html.indexOf("masa lambasi")).toBeLessThan(html.indexOf("bel cantasi"));
    expect(html).toContain('href="/ara?q=masa%20lambasi"');
    expect(html).toContain('href="/ara?q=bel%20cantasi"');
  });

  it("eski sabit örnek kartlar artık yok", () => {
    const html = render([]);
    for (const demo of ["Beyaz sneaker", "Çalışma koltuğu", "Popüler arama", "Trend fikir"]) {
      expect(html).not.toContain(demo);
    }
  });

  it("kayıt görseli yoksa görsel uydurulmaz", () => {
    const html = render(toRecentSearchChips([{ queryNorm: "masa lambasi", searchedAt: at }]));
    expect(html).not.toContain("<img");
  });
});
