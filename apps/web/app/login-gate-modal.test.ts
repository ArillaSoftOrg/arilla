import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginGateModal } from "./login-gate-modal-client.tsx";

afterEach(() => vi.unstubAllGlobals());

function providerLinks(next?: string): string[] {
  const html = renderToStaticMarkup(
    createElement(LoginGateModal, { open: true, onClose: () => {}, next }),
  );
  return [...html.matchAll(/href="(\/giris\/(?:google|apple)[^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

describe("giris kapisinin ilk yuklemesi", () => {
  it("sunucu ile ilk tarayici render'inda ayni giris linklerini kullanir", () => {
    const serverLinks = providerLinks();
    vi.stubGlobal("window", {
      location: { pathname: "/ara", search: "?q=kulakl%C4%B1k" },
    });
    expect(providerLinks()).toEqual(serverLinks);
  });

  it("cagiranin verdigi donus yolunu sorgusuyla korur", () => {
    vi.stubGlobal("window", { location: { pathname: "/baska", search: "" } });
    const next = "/ara?q=kulakl%C4%B1k&sort=best_deal";
    expect(providerLinks(next)).toEqual([
      `/giris/google?next=${encodeURIComponent(next)}`,
      `/giris/apple?next=${encodeURIComponent(next)}`,
    ]);
  });
});
