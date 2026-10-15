/**
 * Link araması herkese açık (`LINK_SEARCH_PUBLIC = true`, karar 0107/0108):
 * `/ara/link` "Yakında" yerine gerçek akışı çalıştırır. Hesap/ürün kapısı hâlâ ilk
 * adımdır; geçersiz ve iç ağa giden adresler kuyruğa ve veritabanına hiç gitmez.
 * Veritabanı ve Redis gerekmez: arka uç çağrıları sahte.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ calls: 0, user: { id: 1, role: "admin" } as unknown }));
vi.mock("../../lib/dal.ts", () => ({
  requireProductAccess: async () => {
    access.calls += 1;
    return access.user;
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
  getDatabase: () => ({}),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const { LINK_SEARCH_PUBLIC, InvalidUrlError, RedisUnavailableError } = await import("@arilla/core");
const { LinkSearchComingSoon } = await import("./link-search-coming-soon.tsx");

const KEY = "b3b2f6d4-8c1e-4a7b-9f0a-2d6c5e4f3a21";

beforeEach(() => {
  access.calls = 0;
  access.user = { id: 1, role: "admin" };
  for (const fn of Object.values(backend)) fn.mockReset();
});

describe("link araması açık", () => {
  it("bayrak açık", () => {
    expect(LINK_SEARCH_PUBLIC).toBe(true);
  });

  it("yükleme durumu 'Yakında' değil", async () => {
    const loading = (await import("./loading.tsx")).default() as ReactElement;
    expect(loading.type).not.toBe(LinkSearchComingSoon);
  });

  it("adres yoksa /ara'ya yönlenir; arka uca gidilmez", async () => {
    const page = (await import("./page.tsx")).default;
    await expect(page({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/ara");
    expect(access.calls).toBe(1);
    expect(backend.getLinkSearchState).not.toHaveBeenCalled();
  });

  it.each([
    "gecersiz",
    "ftp://magaza.example/urun/1",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:3000/urun",
    "https://kullanici:sifre@magaza.example/urun",
  ])(
    "geçersiz ya da iç ağ adresi %s 'Yakında' değil, hata durumu gösterir ve arka uca gitmez",
    async (url) => {
      const page = (await import("./page.tsx")).default;
      const element = (await page({ searchParams: Promise.resolve({ url }) })) as ReactElement;
      expect(element.type).not.toBe(LinkSearchComingSoon);
      expect(backend.findKnownOfferByUrl).not.toHaveBeenCalled();
      expect(backend.getLinkSearchState).not.toHaveBeenCalled();
    },
  );

  it("geçerli adreste durum sorgulanır", async () => {
    backend.findKnownOfferByUrl.mockResolvedValue(null);
    backend.getLinkSearchState.mockResolvedValue({ status: "none" });
    const page = (await import("./page.tsx")).default;
    const url = "https://magaza.example/urun/1";
    await page({ searchParams: Promise.resolve({ url }) });
    expect(backend.findKnownOfferByUrl).toHaveBeenCalledTimes(1);
    expect(backend.getLinkSearchState).toHaveBeenCalledTimes(1);
  });
});

describe("startLinkSearchAction", () => {
  const start = async (url: string, key = KEY) =>
    (await import("./actions.ts")).startLinkSearchAction(url, key);

  it("hesapsız kullanıcı kuyruğa istek açamaz", async () => {
    access.user = null;
    expect(await start("https://magaza.example/urun/1")).toEqual({
      status: "failed",
      errorCode: "login_required",
    });
    expect(backend.runChargedLinkSearch).not.toHaveBeenCalled();
  });

  it("geçersiz istek anahtarı reddedilir", async () => {
    expect(await start("https://magaza.example/urun/1", "kisa")).toEqual({
      status: "failed",
      errorCode: "unexpected",
    });
    expect(backend.runChargedLinkSearch).not.toHaveBeenCalled();
  });

  it("geçerli adres hak/kuyruk akışına verilir", async () => {
    backend.runChargedLinkSearch.mockResolvedValue({ status: "queued", requestId: "r1" });
    expect(await start("https://magaza.example/urun/1")).toEqual({
      status: "queued",
      requestId: "r1",
    });
    expect(backend.runChargedLinkSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ urlRaw: "https://magaza.example/urun/1", requestKey: KEY }),
    );
  });

  it("SSRF/geçersiz adres çekirdekte InvalidUrlError olur ve invalid_url döner", async () => {
    backend.runChargedLinkSearch.mockRejectedValue(new InvalidUrlError("iç ağ"));
    expect(await start("http://127.0.0.1/x")).toEqual({
      status: "failed",
      errorCode: "invalid_url",
    });
  });

  it("kuyruk erişilemezse geçici hata kodu döner", async () => {
    backend.runChargedLinkSearch.mockRejectedValue(new RedisUnavailableError("kuyruk"));
    expect(await start("https://magaza.example/urun/1")).toEqual({
      status: "failed",
      errorCode: "queue_unavailable",
    });
  });
});
