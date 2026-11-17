import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  access: true,
  discoveryEmpty: false,
  trends: [] as { id: number; title: string; slug: string; featured: boolean }[],
  discovery: vi.fn(async () => []),
  catalog: vi.fn(),
  loadTrends: vi.fn(),
}));

vi.mock("@arilla/core", () => ({
  canAccessProduct: () => state.access,
  isProductOpen: () => state.access,
  isChatDiscoveryEnabled: () => false,
  isChatImageEnabled: () => false,
  hasChatImageConsent: async () => false,
  getDiscoverySlots: state.discovery,
  getHomepageProducts: state.catalog,
  getPublicTrends: state.loadTrends,
  todaySlotDate: () => "2026-10-22",
}));
vi.mock("@arilla/db", () => ({ getDatabase: () => ({}) }));
vi.mock("./lib/dal.ts", () => ({ verifySession: async () => null }));
vi.mock("./lib/early-access-progress.ts", () => ({
  loadCachedEarlyAccessProgress: async () => null,
}));
vi.mock("./home-recent-products.ts", () => ({ loadRecentProducts: async () => [] }));
vi.mock("./home-search-composer-client.tsx", () => ({
  // Başlık artık kompozitörün içinde (kategori durumuna bağlı); sayfa yalnızca onu çerçeveler.
  HomeSearchComposer: ({ afterSearch }: { afterSearch?: ReactNode }) =>
    createElement(
      "div",
      null,
      createElement(
        "search",
        null,
        createElement("h1", { id: "anasayfa-baslik" }, "Parfüm için ne arıyorsun?"),
        createElement("form", { "aria-label": "Ürün ara" }),
      ),
      afterSearch,
    ),
}));
vi.mock("./public-site-shell.tsx", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
vi.mock("./coming-soon-landing.tsx", () => ({
  ComingSoonLanding: () => createElement("p", null, "Erken erişim"),
}));
vi.mock("./sohbet/actions.ts", () => ({ startConversationAction: async () => {} }));
vi.mock("./trendler/trend-cards.tsx", () => ({
  TrendCardGrid: ({ trends }: { trends: typeof state.trends }) =>
    createElement(
      "ul",
      null,
      trends.map((trend) =>
        createElement(
          "li",
          { key: trend.id },
          createElement("a", { href: `/trendler/${trend.slug}` }, trend.title),
        ),
      ),
    ),
}));

import { DEMO_HOMEPAGE_TRENDS } from "../data/demo/homepage-trends.ts";
import { HOME_COPY } from "./home-copy.ts";
import HomePage from "./page.tsx";

beforeEach(() => {
  state.access = true;
  state.discoveryEmpty = false;
  state.trends = [];
  state.discovery.mockClear();
  state.catalog.mockReset().mockImplementation(async () =>
    state.discoveryEmpty
      ? []
      : [
          {
            productId: 1,
            title: "Ürün",
            primaryImageUrl: "/test.png",
            slug: "ornek",
            minPrice: 10000,
            offerCount: 1,
          },
        ],
  );
  state.loadTrends.mockReset().mockImplementation(async () => state.trends);
});

describe("urun acik ana sayfa bilgi mimarisi", () => {
  it("ilk arama alaninda baslik vardir; robot kaldirilmistir", async () => {
    const html = renderToStaticMarkup(await HomePage());
    const hero = html.slice(html.indexOf("<section"), html.indexOf("</section>"));
    // Başlık "[Kategori] için ne arıyorsun?": kategori açılır liste başlığın içindedir.
    expect(hero).toMatch(/<h1[^>]*id="anasayfa-baslik"[^>]*>.*Parfüm.*için ne arıyorsun?/s);
    expect(hero).toContain(HOME_COPY.heroTitleSuffix);
    expect(hero).not.toContain(HOME_COPY.heroTitleLead);
    expect(hero).not.toContain(HOME_COPY.heroTitleAccent);
    expect(hero).not.toContain(HOME_COPY.heroSubtitle);
    expect(hero).not.toContain("robot-welcome.png");
    expect(hero).not.toContain("robot-research.png");
    expect(html).not.toContain("robot-how-it-works-point-v1.png");
    expect(html).not.toContain('href="/nasil-calisir"');
    expect(html).not.toContain("ilk kez mi");
    expect(hero).not.toContain("Yakında");
    expect(html).not.toContain('id="nasil-calisir"');
  });

  it("hero -> trendler -> kesfet sirasini ve gercek koleksiyon linkini korur", async () => {
    state.trends = [{ id: 1, title: "Çalışma alanı", slug: "calisma-alani", featured: true }];
    const html = renderToStaticMarkup(await HomePage());
    expect(html.indexOf("</section>")).toBeLessThan(html.indexOf('id="trendler"'));
    expect(html.indexOf('id="trendler"')).toBeLessThan(html.indexOf('id="kesfet"'));
    expect(html).toContain('href="/trendler/calisma-alani"');
    expect(html).toContain("Şu sıralar öne çıkanlar");
    expect(html).toMatch(/id="kesfet-baslik"[^>]*>Keşfet</);
    expect(html.match(/<section\b/g)).toHaveLength(3);
  });

  it("trend verisi bosken bolumu kullanicidan gizler", async () => {
    const html = renderToStaticMarkup(await HomePage());
    expect(html).not.toContain('id="trendler"');
    expect(html).not.toContain(HOME_COPY.trendsEmptyTitle);
    expect(html).not.toContain(HOME_COPY.trendsEmptyDescription);
    expect(html).not.toContain(DEMO_HOMEPAGE_TRENDS[0]?.title);
    expect(html).not.toContain(HOME_COPY.trendsSubtitle);
    expect(html).not.toContain('href="/trendler"');
  });

  it("trend sorgusu hata verdiginde arama ve kesfet calismaya devam eder", async () => {
    state.loadTrends.mockRejectedValueOnce(new Error("test"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(await HomePage());
      expect(html).not.toContain('id="trendler"');
      expect(html).not.toContain(HOME_COPY.trendsEmptyTitle);
      expect(html).toContain('aria-label="Ürün ara"');
      expect(html).toContain('id="kesfet"');
      expect(html).not.toContain(DEMO_HOMEPAGE_TRENDS[0]?.title);
    } finally {
      warning.mockRestore();
    }
  });

  it("kesif verisi bosken bolum ve Keşfet basligi kaybolmaz", async () => {
    state.discoveryEmpty = true;
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain('id="kesfet"');
    expect(html).toMatch(/id="kesfet-baslik"[^>]*>Keşfet</);
    expect(html).toContain(HOME_COPY.kesfetEmptyTitle);
    expect(html).not.toContain('href="/urun/ornek"');
    expect(html.indexOf('id="trendler"')).toBeLessThan(html.indexOf('id="kesfet"'));
  });

  it("erken erisim dalina robot/CTA eklemez ve urun sorgularini calistirmaz", async () => {
    state.access = false;
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toBe("<p>Erken erişim</p>");
    expect(state.discovery).not.toHaveBeenCalled();
    expect(state.loadTrends).not.toHaveBeenCalled();
    expect(state.catalog).not.toHaveBeenCalled();
  });
});
