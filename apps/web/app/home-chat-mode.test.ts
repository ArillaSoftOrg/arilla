import { describe, expect, it } from "vitest";
import {
  homeConversationHref,
  homeMode,
  homeSearchHref,
  isPrivateHomeMode,
} from "./home-chat-mode.ts";

const ID = "8c1f0d2e-1234-4abc-9def-001122334455";

describe("homeMode (karar 0204)", () => {
  it("parametresiz ve ilgisiz parametreler: ana sayfa", () => {
    expect(homeMode({}, true)).toEqual({ kind: "home" });
    expect(homeMode({ utm_source: "x" }, true)).toEqual({ kind: "home" });
    expect(homeMode({ q: "   " }, true)).toEqual({ kind: "home" });
    expect(homeMode({ q: "" }, true)).toEqual({ kind: "home" });
  });

  it("q: arama turu (sohbet kapaliyken de calisir)", () => {
    expect(homeMode({ q: "terlik" }, true)).toEqual({ kind: "search" });
    expect(homeMode({ q: "terlik" }, false)).toEqual({ kind: "search" });
    expect(homeMode({ q: ["a", "b"] }, true)).toEqual({ kind: "search" });
  });

  it("s: gecerli UUID konusma; sirala ve ac korunur; kimlik kucuk harfe indirilir", () => {
    expect(homeMode({ s: ID.toUpperCase() }, true)).toEqual({
      kind: "conversation",
      conversationId: ID,
    });
    expect(homeMode({ s: ID, sirala: "firsat", ac: "3,4" }, true)).toEqual({
      kind: "conversation",
      conversationId: ID,
      sirala: "firsat",
      ac: "3,4",
    });
  });

  it("s: UUID degilse ya da sohbet kapaliysa 404; s her zaman q'dan once", () => {
    expect(homeMode({ s: "12345" }, true)).toEqual({ kind: "not_found" });
    expect(homeMode({ s: "" }, true)).toEqual({ kind: "not_found" });
    expect(homeMode({ s: ID }, false)).toEqual({ kind: "not_found" });
    expect(homeMode({ s: ID, q: "terlik" }, true).kind).toBe("conversation");
  });

  it("ozel yuzeyler (conversation/search/not_found) dizinlenmez; ana sayfa dizinlenir", () => {
    expect(isPrivateHomeMode({ kind: "home" })).toBe(false);
    expect(isPrivateHomeMode({ kind: "search" })).toBe(true);
    expect(isPrivateHomeMode({ kind: "conversation", conversationId: ID })).toBe(true);
    expect(isPrivateHomeMode({ kind: "not_found" })).toBe(true);
  });
});

describe("adres uretimi", () => {
  it("konusma ve arama adresleri", () => {
    expect(homeConversationHref(ID)).toBe(`/?s=${ID}`);
    expect(homeConversationHref(ID, { sirala: "firsat", ac: "2" })).toBe(
      `/?s=${ID}&sirala=firsat&ac=2`,
    );
    expect(homeSearchHref("rahat yürüyüş ayakkabısı")).toBe(
      "/?q=rahat+y%C3%BCr%C3%BCy%C3%BC%C5%9F+ayakkab%C4%B1s%C4%B1",
    );
  });
});
