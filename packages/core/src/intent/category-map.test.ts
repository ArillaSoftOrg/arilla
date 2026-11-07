import { describe, expect, it } from "vitest";
import { CATALOG_PRODUCT_TYPES } from "../clarification/product-types.ts";
import {
  HARD_MAX_NO_CATEGORY,
  HARD_MIN_IN_PATH,
  INTENT_CATEGORY_MAP,
  intentCategoryFor,
} from "./category-map.ts";

/** Uretimde bos ya da neredeyse bos olculen kokler (2026-11-07). */
const EMPTY_IN_PRODUCTION = ["saglik-kozmetik", "anne-bebek", "kitap-muzik-hobi", "ev-yasam"];

describe("IntentV2 kategori eslemesi (uretimde dogrulanmis)", () => {
  it("modelin secebildigi her tur icin bir kayit var", () => {
    for (const type of CATALOG_PRODUCT_TYPES)
      expect(intentCategoryFor(type.id), type.id).not.toBeNull();
  });

  it("hicbir yol uretimde bos olculen koklere isaret etmez", () => {
    for (const [id, entry] of Object.entries(INTENT_CATEGORY_MAP)) {
      for (const path of [entry.hardPath, entry.hintPath]) {
        const root = path.split("/")[0];
        expect(EMPTY_IN_PRODUCTION, `${id}: ${path}`).not.toContain(root);
      }
    }
  });

  it("ipucu yolu kesin yolun alt agacindadir (kategori filtresi alt kategorileri kapsar)", () => {
    for (const [id, entry] of Object.entries(INTENT_CATEGORY_MAP)) {
      expect(
        entry.hintPath === entry.hardPath || entry.hintPath.startsWith(`${entry.hardPath}/`),
        id,
      ).toBe(true);
    }
  });

  it("kesin filtre yalnizca olcum esigini gecen turlerde", () => {
    for (const [id, entry] of Object.entries(INTENT_CATEGORY_MAP)) {
      const { sampled, inPath, noCategory } = entry.evidence;
      const passes =
        sampled >= 1000 &&
        inPath / sampled >= HARD_MIN_IN_PATH &&
        noCategory / sampled <= HARD_MAX_NO_CATEGORY;
      expect(entry.hard, id).toBe(passes);
    }
  });

  it("bugunku olcumle yalnizca oyun konsolu kesin filtre", () => {
    const hard = Object.entries(INTENT_CATEGORY_MAP)
      .filter(([, e]) => e.hard)
      .map(([id]) => id);
    expect(hard).toEqual(["game_console"]);
  });
});
