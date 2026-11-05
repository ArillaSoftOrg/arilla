import type { SearchIntent } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { chatFilterDraft, chatFilterMessage, parseChatPrice } from "./chat-product-model.ts";

const intent: SearchIntent = {
  query: "spor ayakkabı",
  category: "ayakkabı",
  brand: "adidas",
  excludeBrands: [],
  colors: ["beyaz"],
  size: "38",
  priceMin: null,
  priceMax: 4000,
  attributes: {},
  sort: null,
};

describe("sohbette fiyat ve filtre girdileri", () => {
  it("ondalık TL tutarını kuruşa tam olarak çevirir", () => {
    expect(parseChatPrice(" 2500,50 ")).toBe(250050);
    expect(parseChatPrice("0.01")).toBe(1);
    expect(parseChatPrice("123.4")).toBe(12340);
    for (const input of [
      "",
      "0",
      "-1",
      "1e4",
      "1.234",
      "1,2,3",
      "1.000,00",
      "999999999999999999",
    ]) {
      expect(parseChatPrice(input)).toBeNull();
    }
  });
  it("yalnızca değişen tercihleri normal sohbet mesajına hazırlar", () => {
    const draft = chatFilterDraft(intent);
    expect(chatFilterMessage(intent, draft)).toBe("");
    draft.priceMax = "3000";
    expect(chatFilterMessage(intent, draft)).toBe("Bütçem en fazla 3000 TL olsun.");
    draft.brand = "";
    expect(chatFilterMessage(intent, draft)).toBe(
      "Marka kısıtını kaldır. Bütçem en fazla 3000 TL olsun.",
    );
    expect(intent.brand).toBe("adidas");
  });
  it("kaldırma ile sıfır alt bütçeyi ayırır; ters aralığı kabul etmez", () => {
    const draft = { ...chatFilterDraft(intent), priceMin: "0", priceMax: "" };
    expect(chatFilterMessage(intent, draft)).toBe(
      "Bütçem en az 0 TL olsun. Bütçenin üst sınırını kaldır.",
    );
    expect(chatFilterMessage(intent, { ...draft, priceMin: "4000", priceMax: "3000" })).toBeNull();
    expect(chatFilterMessage(intent, { ...draft, priceMax: "1e5" })).toBeNull();
    expect(chatFilterMessage(intent, { ...draft, brand: "https://example.com" })).toBeNull();
  });
});
