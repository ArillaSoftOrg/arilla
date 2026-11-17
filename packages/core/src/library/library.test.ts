import { describe, expect, it } from "vitest";
import { decodeLibraryCursor, encodeLibraryCursor, selectLibraryCandidates } from "./library.ts";

const items = [{ productId: 11 }, { productId: 12 }, { productId: 13 }, { productId: 14 }];
const base = { mode: "results", items, sort: "balanced", isNewSearch: true, page: 1 };

describe("selectLibraryCandidates", () => {
  it("ilk 3 gerçek sonucu sırasıyla seçer", () => {
    expect(selectLibraryCandidates(base)).toEqual([
      { productId: 11, rank: 1 },
      { productId: 12, rank: 2 },
      { productId: 13, rank: 3 },
    ]);
  });

  it("fallback, empty, sayfa 2, sekme değişimi ve devam adımında aday üretmez", () => {
    expect(selectLibraryCandidates({ ...base, mode: "fallback" })).toEqual([]);
    expect(selectLibraryCandidates({ ...base, mode: "empty" })).toEqual([]);
    expect(selectLibraryCandidates({ ...base, page: 2 })).toEqual([]);
    expect(selectLibraryCandidates({ ...base, sort: "cheapest" })).toEqual([]);
    expect(selectLibraryCandidates({ ...base, isNewSearch: false })).toEqual([]);
  });

  it("geçersiz ve yinelenen kimlikleri atlar", () => {
    const out = selectLibraryCandidates({
      ...base,
      items: [
        { productId: 0 },
        { productId: 5 },
        { productId: 5 },
        { productId: 1.5 },
        { productId: 6 },
      ],
    });
    expect(out).toEqual([
      { productId: 5, rank: 1 },
      { productId: 6, rank: 2 },
    ]);
  });
});

describe("kütüphane imleci", () => {
  it("gidiş dönüş", () => {
    const at = new Date("2026-11-17T10:00:00.000Z");
    expect(decodeLibraryCursor(encodeLibraryCursor(at, 42))).toEqual({ at, productId: 42 });
  });

  it("bozuk imleç null döner", () => {
    expect(decodeLibraryCursor("x|y")).toBeNull();
    expect(decodeLibraryCursor(null)).toBeNull();
    expect(decodeLibraryCursor("2026-11-17T10:00:00.000Z|-3")).toBeNull();
  });
});
