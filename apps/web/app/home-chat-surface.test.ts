import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Karar 0204: `/?s=<id>` ve `/?q=<sorgu>` ana sayfada acilir. Burada yalnizca yonlendirme/404/kabuk
 * kararlari sinanir; konusma ve arama bilesenleri kendi testlerinde.
 */
const ID = "8c1f0d2e-1234-4abc-9def-001122334455";
const state = vi.hoisted(() => ({
  chat: true,
  user: null as { id: number } | null,
  open: true,
}));

vi.mock("@arilla/core", () => ({
  canAccessProduct: () => state.open,
  isProductOpen: () => state.open,
  isChatDiscoveryEnabled: () => state.chat,
  isChatImageEnabled: () => false,
  hasChatImageConsent: async () => false,
  getDiscoverySlots: async () => [],
  getHomepageProducts: async () => [],
  getPublicTrends: async () => [],
  todaySlotDate: () => "2026-11-15",
}));
vi.mock("@arilla/core/auth-redirect", () => ({
  loginPathWithNext: (next: string) => `/giris?next=${encodeURIComponent(next)}`,
}));
vi.mock("@arilla/db", () => ({ getDatabase: () => ({}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock("./lib/dal.ts", () => ({ verifySession: async () => state.user }));
vi.mock("./lib/early-access-progress.ts", () => ({
  loadCachedEarlyAccessProgress: async () => null,
}));
vi.mock("./home-recent-products.ts", () => ({ loadRecentProducts: async () => [] }));
vi.mock("./home-search-composer-client.tsx", () => ({
  HomeSearchComposer: () => createElement("p", null, "HERO-KUTUSU"),
}));
vi.mock("./public-site-shell.tsx", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) =>
    createElement("main", { "data-chrome": "site" }, children),
  SubpageShell: ({ children, chrome }: { children: ReactNode; chrome?: string }) =>
    createElement("main", { "data-chrome": chrome }, children),
}));
vi.mock("./coming-soon-landing.tsx", () => ({
  ComingSoonLanding: () => createElement("p", null, "Erken erişim"),
}));
vi.mock("./sohbet/actions.ts", () => ({ startConversationAction: async () => {} }));
vi.mock("./sohbet/conversation-view.tsx", () => ({
  ConversationView: (props: { conversationId: string; sirala?: string; ac?: string }) =>
    createElement(
      "section",
      { "data-view": "conversation" },
      `${props.conversationId}|${props.sirala ?? ""}|${props.ac ?? ""}`,
    ),
}));
vi.mock("./lib/search/search-page.tsx", () => ({
  SearchPage: async () => createElement("section", { "data-view": "search" }, "ARAMA"),
}));
vi.mock("./trendler/trend-cards.tsx", () => ({ TrendCardGrid: () => null }));

import HomePage, { generateMetadata } from "./page.tsx";

const render = async (params: Record<string, string>) =>
  renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve(params) }));

beforeEach(() => {
  state.chat = true;
  state.user = { id: 7 };
  state.open = true;
});

describe("ana sayfada sohbet ve arama turu (karar 0204)", () => {
  it("parametresiz: hero + kutu; sohbet kabugu yok", async () => {
    const html = await render({});
    expect(html).toContain("HERO-KUTUSU");
    expect(html).not.toContain('data-chrome="chat"');
  });

  it("/?s=<id>: sohbet kabugu (chrome=chat) ve konusma; hero cizilmez; sirala/ac gecer", async () => {
    const html = await render({ s: ID, sirala: "firsat", ac: "3" });
    expect(html).toContain('data-chrome="chat"');
    expect(html).toContain(`${ID}|firsat|3`);
    expect(html).not.toContain("HERO-KUTUSU");
  });

  it("/?s=<id> girissiz: giris sonrasi ayni konusmaya donmek uzere /giris'e", async () => {
    state.user = null;
    await expect(render({ s: ID })).rejects.toThrow(
      `REDIRECT:/giris?next=${encodeURIComponent(`/?s=${ID}`)}`,
    );
  });

  it("/?s= gecersiz kimlik ya da sohbet kapali: 404", async () => {
    await expect(render({ s: "abc" })).rejects.toThrow("NOT_FOUND");
    state.chat = false;
    await expect(render({ s: ID })).rejects.toThrow("NOT_FOUND");
  });

  it("/?q=: arama turu sohbet kabugunda; anonim kullanici da gorur", async () => {
    state.user = null;
    const html = await render({ q: "kadın terlik" });
    expect(html).toContain('data-chrome="chat"');
    expect(html).toContain("ARAMA");
    expect(html).not.toContain("HERO-KUTUSU");
  });

  it("urun kapaliyken ?s/?q landing'e duser (yonlendirme/sizinti yok)", async () => {
    state.open = false;
    expect(await render({ q: "terlik" })).toContain("Erken erişim");
    expect(await render({ s: ID })).toContain("Erken erişim");
  });
});

describe("metadata: ozel yuzeyler dizinlenmez, kanonik /", () => {
  it("/?s= ve /?q=: noindex, canonical /", async () => {
    for (const params of [{ s: ID }, { q: "terlik" }]) {
      const meta = await generateMetadata({ searchParams: Promise.resolve(params) });
      expect(meta.robots).toEqual({ index: false, follow: false });
      expect(meta.alternates?.canonical).toBe("/");
    }
  });

  it("parametresiz ana sayfa dizinlenir (robots yok), kanonik /", async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(meta.robots).toBeUndefined();
    expect(meta.alternates?.canonical).toBe("/");
  });
});
