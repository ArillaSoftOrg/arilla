import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "../search/lexicon.ts";
import { analyzeLocally } from "./local-analysis.ts";
import { fromRawQuery } from "./normalized-query-adapter.ts";
import { decideRoute } from "./route.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "brand", surface: "samsung", normalized: "samsung", weight: 1 },
  { kind: "brand", surface: "apple", normalized: "apple", weight: 1 },
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "category", surface: "ayakkabı", normalized: "moda/ayakkabi", weight: 1 },
];

function route(q: string, context = { eligible: true, cacheHit: false }) {
  return decideRoute(analyzeLocally(fromRawQuery(q), LEXICON), context);
}

describe("yerel analiz yeterliyse model çağrılmaz", () => {
  it.each(["samsung s24", "siyah ayakkabı", "tablet", "monitör"])("%s", (q) => {
    const decision = route(q);
    expect(decision.callModel).toBe(false);
  });
});

describe("ilişki, olumsuzluk ve aksesuar sorguları modele gider", () => {
  it("için -> relation_marker", () => {
    expect(route("iPhone 15 Pro Max için kılıf").reasons).toContain("relation_marker");
  });
  it("olmayan -> negation", () => {
    expect(route("kablosuz olmayan oyuncu faresi").reasons).toContain("negation");
  });
  it("cihaz + aksesuar -> accessory_with_device", () => {
    expect(route("samsung telefonuma şarj aleti").reasons).toContain("accessory_with_device");
  });
  it("birim + tür -> unit_and_type", () => {
    expect(route("27 inç 144hz monitör").reasons).toContain("unit_and_type");
  });
  it("'kablosuz' eki olumsuzluk sayılmaz", () => {
    expect(route("kablosuz kulaklık").reasons).not.toContain("negation");
  });
});

describe("kapılar", () => {
  it("süzgeç reddettiyse çağrı yok", () => {
    expect(route("iPhone 15 için kılıf", { eligible: false, cacheHit: false })).toEqual({
      callModel: false,
      reasons: ["ineligible"],
    });
  });
  it("önbellek isabetinde çağrı yok", () => {
    expect(route("iPhone 15 için kılıf", { eligible: true, cacheHit: true }).callModel).toBe(false);
  });
  it("tek token çağrı yok", () => {
    expect(route("kılıf").reasons).toEqual(["single_token"]);
  });
});
