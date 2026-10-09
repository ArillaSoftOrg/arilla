/**
 * Link araması geçici olarak kapalı (`LINK_SEARCH_PUBLIC = false`): `/ara/link`
 * ve yükleme durumu "Yakında" gösterir, start action kuyruğa hiçbir şey
 * bırakmaz. Ürün kapısı (`requireProductAccess`) hâlâ ilk adımdır.
 * Veritabanı ve Redis gerekmez: arka uç çağrıları sahte, çağrılmadıkları
 * doğrulanır.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../lib/dal.ts", () => ({
  requireProductAccess: async () => {
    access.calls += 1;
    return { id: 1, role: "admin" };
  },
}));

const backend = vi.hoisted(() => ({
  runChargedLinkSearch: vi.fn(),
  findKnownOfferByUrl: vi.fn(),
  getLinkSearchState: vi.fn(),
}));
vi.mock("@arilla/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arilla/core")>()),
  ...backend,
}));
vi.mock("@arilla/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arilla/db")>()),
  getDatabase: () => {
    throw new Error("veritabanina gidilmemeli");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("cerez okunmamali");
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`yonlendirilmemeli: ${to}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));
vi.mock("../../photo-search-client.tsx", () => ({ PhotoSearchButton: () => null }));

const { LINK_SEARCH_PUBLIC } = await import("@arilla/core");
const { LinkSearchComingSoon } = await import("./link-search-coming-soon.tsx");
const { LINK_SEARCH_COPY } = await import("./link-search-copy.ts");

beforeEach(() => {
  access.calls = 0;
  for (const fn of Object.values(backend)) fn.mockClear();
});

describe("link araması 'Yakında'", () => {
  it("bayrak kapalı", () => {
    expect(LINK_SEARCH_PUBLIC).toBe(false);
  });

  it.each([
    {},
    { url: "https://magaza.example/urun/1" },
    { url: "https://magaza.example/urun/1?utm_source=x" },
    { url: "gecersiz" },
  ])("/ara/link %o 404 ya da yönlendirme olmadan 'Yakında' gösterir", async (params) => {
    const page = (await import("./page.tsx")).default;
    const element = (await page({ searchParams: Promise.resolve(params) })) as ReactElement;
    expect(element.type).toBe(LinkSearchComingSoon);
    expect(access.calls).toBe(1);
    expect(backend.findKnownOfferByUrl).not.toHaveBeenCalled();
    expect(backend.getLinkSearchState).not.toHaveBeenCalled();
  });

  it("yükleme durumu da iskelet değil 'Yakında'", async () => {
    const loading = (await import("./loading.tsx")).default() as ReactElement;
    expect(loading.type).toBe(LinkSearchComingSoon);
  });

  it("metin: başlık, açıklama ve linksiz arama kutusu; büyük harf yok", () => {
    const html = renderToStaticMarkup(LinkSearchComingSoon());
    expect(html).toContain(LINK_SEARCH_COPY.comingSoonTitle);
    expect(html).toContain("Link ile ürün arama özelliği yakında aktif olacak.");
    expect(html).toContain(LINK_SEARCH_COPY.comingSoonPlaceholder);
    expect(html).not.toContain("bağlantısı");
    expect(LINK_SEARCH_COPY.comingSoonDescription).not.toMatch(/\b[A-ZÇĞİÖŞÜ]{4,}\b/);
  });

  it("start action arayüz atlansa da kuyruğa istek açmaz", async () => {
    const { startLinkSearchAction } = await import("./actions.ts");
    expect(
      await startLinkSearchAction("https://magaza.example/urun/1", "coming-soon-request-key-1"),
    ).toEqual({ status: "failed", errorCode: "coming_soon" });
    expect(access.calls).toBe(1);
    expect(backend.runChargedLinkSearch).not.toHaveBeenCalled();
  });
});
