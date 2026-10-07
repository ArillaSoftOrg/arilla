import { describe, expect, it } from "vitest";
import type { SearchIntent, SearchIntentPatch } from "./contract.ts";
import { emptyIntent, intentChips, mergeSearchIntent, parseStoredIntent } from "./intent.ts";

const patch = (p: Partial<SearchIntentPatch> = {}): SearchIntentPatch => ({
  reset: false,
  clear: false,
  remove: [],
  ...p,
});

const BASE: SearchIntent = {
  ...emptyIntent("günlük spor ayakkabı"),
  category: "ayakkabı",
  attributes: { usage: "günlük" },
};

describe("mergeSearchIntent (refinement keeps the previous intent)", () => {
  it("builds the first intent from a patch with a query", () => {
    const merged = mergeSearchIntent(null, patch({ query: "spor ayakkabı", category: "ayakkabı" }));
    expect(merged).toEqual({ ...emptyIntent("spor ayakkabı"), category: "ayakkabı" });
  });

  it("cannot build an intent without any query", () => {
    expect(mergeSearchIntent(null, patch({ brand: "Nike" }))).toBeNull();
    expect(mergeSearchIntent(BASE, patch({ reset: true, brand: "Nike" }))).toBeNull();
  });

  it("'siyah olsun' adds color without resetting the query", () => {
    const merged = mergeSearchIntent(BASE, patch({ colors: ["siyah"] }));
    expect(merged).toMatchObject({
      query: "günlük spor ayakkabı",
      category: "ayakkabı",
      colors: ["siyah"],
      attributes: { usage: "günlük" },
    });
  });

  it("'Nike olsun' sets brand; '2500 TL altı' sets the price cap; both survive later turns", () => {
    const a = mergeSearchIntent(BASE, patch({ brand: "Nike" }));
    const b = mergeSearchIntent(a, patch({ priceMax: 2500 }));
    const c = mergeSearchIntent(b, patch({ colors: ["siyah"] }));
    expect(c).toMatchObject({ brand: "Nike", priceMax: 2500, colors: ["siyah"] });
    expect(c?.query).toBe("günlük spor ayakkabı");
  });

  it("'daha uygun fiyatlı' sets the sort preference only", () => {
    const merged = mergeSearchIntent(BASE, patch({ sort: "cheapest" }));
    expect(merged).toEqual({ ...BASE, sort: "cheapest" });
  });

  it("does not mutate the previous intent", () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    mergeSearchIntent(
      BASE,
      patch({ colors: ["siyah"], excludeBrands: ["Puma"], attributes: { a: "b" } }),
    );
    expect(BASE).toEqual(snapshot);
  });

  it("reset drops everything from the previous intent", () => {
    const withBrand = { ...BASE, brand: "Nike", priceMax: 2500 };
    const merged = mergeSearchIntent(withBrand, patch({ reset: true, query: "kulaklık" }));
    expect(merged).toEqual(emptyIntent("kulaklık"));
  });

  it("remove clears fields before the patch values apply", () => {
    const withBrand = { ...BASE, brand: "Nike", priceMax: 2500 };
    const merged = mergeSearchIntent(withBrand, patch({ remove: ["brand", "priceMax"] }));
    expect(merged?.brand).toBeNull();
    expect(merged?.priceMax).toBeNull();
    expect(merged?.query).toBe(BASE.query);
  });

  it("a brand excluded later wins over an included one and vice versa", () => {
    const included = { ...BASE, brand: "Nike" };
    expect(mergeSearchIntent(included, patch({ excludeBrands: ["nike"] }))).toMatchObject({
      brand: null,
      excludeBrands: ["nike"],
    });
    const excluded = { ...BASE, excludeBrands: ["Nike"] };
    expect(mergeSearchIntent(excluded, patch({ brand: "nike" }))).toMatchObject({
      brand: "nike",
      excludeBrands: [],
    });
  });

  it("exclusions accumulate without duplicates", () => {
    const a = mergeSearchIntent(BASE, patch({ excludeBrands: ["Puma"] }));
    const b = mergeSearchIntent(a, patch({ excludeBrands: ["puma", "Adidas"] }));
    expect(b?.excludeBrands).toEqual(["Puma", "Adidas"]);
  });

  it("keeps the price range consistent: the new declaration wins", () => {
    const ranged = { ...BASE, priceMin: 2000, priceMax: 3000 };
    expect(mergeSearchIntent(ranged, patch({ priceMax: 1500 }))).toMatchObject({
      priceMin: null,
      priceMax: 1500,
    });
    expect(mergeSearchIntent(ranged, patch({ priceMin: 4000 }))).toMatchObject({
      priceMin: 4000,
      priceMax: null,
    });
  });

  it("merges attributes key by key", () => {
    const merged = mergeSearchIntent(BASE, patch({ attributes: { style: "spor" } }));
    expect(merged?.attributes).toEqual({ usage: "günlük", style: "spor" });
  });
});

describe("parseStoredIntent", () => {
  it("round-trips a merged intent", () => {
    const merged = mergeSearchIntent(BASE, patch({ brand: "Nike", priceMax: 2500 }));
    expect(parseStoredIntent(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
  });

  it("returns null for garbage instead of throwing", () => {
    expect(parseStoredIntent(null)).toBeNull();
    expect(parseStoredIntent("x")).toBeNull();
    expect(parseStoredIntent({ query: 5 })).toBeNull();
  });

  it("drops invalid fields but keeps a usable intent", () => {
    expect(
      parseStoredIntent({ query: "ayakkabı", priceMax: -1, sort: "x", colors: [1, "siyah"] }),
    ).toEqual({
      ...emptyIntent("ayakkabı"),
      colors: ["siyah"],
    });
  });
});

describe("intentChips", () => {
  it("labels in Turkish without forbidden words", () => {
    const labels = intentChips({
      ...BASE,
      brand: "Nike",
      excludeBrands: ["Puma"],
      colors: ["siyah"],
      priceMax: 2500,
      sort: "cheapest",
    }).map((chip) => chip.label);
    expect(labels).toEqual([
      "günlük spor ayakkabı",
      "ayakkabı",
      "Marka: Nike",
      "Puma hariç",
      "siyah",
      "En fazla 2.500 TL",
      "günlük",
      "Fiyata göre",
    ]);
    for (const label of labels) {
      expect(label).not.toMatch(/ucuz|dupe|satın al/i);
    }
  });
});
