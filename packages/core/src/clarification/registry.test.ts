import { describe, expect, it } from "vitest";
import { compileQuery } from "./compile.ts";
import { step } from "./engine.ts";
import { validateRegistry } from "./registry.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "./rules.ts";
import { createInitialState } from "./state.ts";
import { TEST_CATEGORY_PATHS, TEST_CONTEXT } from "./test-fixtures.ts";
import type { ClarificationRegistry, DomainDefinition } from "./types.ts";

describe("varsayilan kural sozlugu", () => {
  it("gecerli: her filtre secenegi aranabilir, kategoriler agacta var, etiketler kurala uygun", () => {
    expect(validateRegistry(DEFAULT_CLARIFICATION_REGISTRY, TEST_CATEGORY_PATHS)).toEqual([]);
  });
});

describe("dogrulama kurallari", () => {
  const base: DomainDefinition = {
    id: "demo",
    kind: "product",
    triggers: ["demo"],
    retrievalTerms: ["demo"],
    facets: [
      {
        id: "kind",
        question: "Hangisi?",
        role: "filter",
        skipLabel: "Fark etmez",
        options: [
          { id: "a", label: "A türü", triggers: [], contribution: { terms: ["a"] } },
          { id: "b", label: "B türü", triggers: [], contribution: { terms: ["b"] } },
        ],
      },
    ],
    questionOrder: [{ facetId: "kind", importance: "essential" }],
    readyAfterSignals: 1,
    maxQuestions: 1,
  };
  const withDomain = (domain: DomainDefinition): ClarificationRegistry => ({ domains: [domain] });

  it("aramaya katkisi olmayan filtre secenegi reddedilir", () => {
    const [facet] = base.facets;
    if (!facet) throw new Error("fixture");
    const issues = validateRegistry(
      withDomain({
        ...base,
        facets: [
          { ...facet, options: [...facet.options, { id: "c", label: "C türü", triggers: [] }] },
        ],
      }),
    );
    expect(issues.map((i) => i.message)).toContain("filtre seceneginin arama katkisi yok");
  });

  it("katalogda olmayan kategori reddedilir", () => {
    const issues = validateRegistry(
      withDomain({ ...base, categoryPath: "yat/malzeme" }),
      TEST_CATEGORY_PATHS,
    );
    expect(issues.map((i) => i.message)).toContain("bilinmeyen kategori: yat/malzeme");
  });

  it("yasakli kelime ve ALL CAPS etiket reddedilir", () => {
    const [facet] = base.facets;
    if (!facet) throw new Error("fixture");
    const issues = validateRegistry(
      withDomain({
        ...base,
        facets: [
          {
            ...facet,
            options: [
              { id: "a", label: "Ucuz olanlar", triggers: [], contribution: { terms: ["a"] } },
              { id: "b", label: "KAPALI", triggers: [], contribution: { terms: ["b"] } },
            ],
          },
        ],
      }),
    );
    expect(issues.map((i) => i.message)).toEqual(['yasakli ifade: "ucuz"', "ALL CAPS etiket"]);
  });

  it("tanimsiz soru sirasi ve ayrilmis kimlik reddedilir", () => {
    const issues = validateRegistry(
      withDomain({ ...base, questionOrder: [{ facetId: "budget", importance: "useful" }] }),
    );
    expect(issues.map((i) => i.message)).toContain("tanimsiz soru: budget");
  });
});

describe("derleme", () => {
  it("niteleyiciler once, bas isim sonda; renk mevcut sozlukten gelir", () => {
    const decision = step(
      createInitialState(),
      { type: "text", text: "siyah erkek koşu ayakkabısı" },
      TEST_CONTEXT,
    );
    const query = compileQuery(decision.state, TEST_CONTEXT.registry, {
      knownCategoryPaths: TEST_CATEGORY_PATHS,
    });
    expect(query.unparsed).toBe("koşu erkek ayakkabı");
    expect(query.filters).toEqual({ color: ["black"] });
    expect(query.intent).toBe("browse");
    expect(query.anchor).toBeNull();
  });

  it("katalogda olmayan kategori katkisi dusurulur", () => {
    const decision = step(createInitialState(), { type: "text", text: "telefon" }, TEST_CONTEXT);
    const query = compileQuery(decision.state, TEST_CONTEXT.registry, {
      knownCategoryPaths: new Set(["moda"]),
    });
    expect(query.filters.category_path).toBeUndefined();
  });

  it("butce kurus cinsinden tamsayi", () => {
    const decision = step(
      createInitialState(),
      { type: "text", text: "1.500 liraya babama hediye" },
      TEST_CONTEXT,
    );
    const query = compileQuery(decision.state, TEST_CONTEXT.registry);
    expect(query.filters.price_max).toBe(150000);
    expect(Number.isInteger(query.filters.price_max)).toBe(true);
  });

  it("ikincil niyet kelimeleri metin kapisina sizmaz", () => {
    const decision = step(
      createInitialState(),
      { type: "text", text: "babama hediye kask" },
      TEST_CONTEXT,
    );
    expect(decision.state.domainId).toBe("helmet");
    expect(decision.state.intent).toBe("gift");
    expect(compileQuery(decision.state, TEST_CONTEXT.registry).unparsed).toBe("kask");
  });
});
