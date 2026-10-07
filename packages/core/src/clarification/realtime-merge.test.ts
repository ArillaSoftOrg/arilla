/**
 * Anlik yorum birlestirme kurallari (karar 0062): acik kullanici beyani >
 * deterministik > Gemini. Saf; veritabani ve model yok.
 */
import { describe, expect, it } from "vitest";
import { replayConversation } from "./engine.ts";
import { applyInterpretation, type ValidatedInterpretation } from "./interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "./rules.ts";
import { applyInput, createInitialState } from "./state.ts";

const context = { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon: [] };

function interpretation(partial: Partial<ValidatedInterpretation>): ValidatedInterpretation {
  return { domainId: null, facets: [], budget: null, pricePreference: null, ...partial };
}

function firstTurn(text: string) {
  return applyInput(createInitialState(), { type: "text", text }, context);
}

describe("applyInterpretation öncelik", () => {
  it("deterministik bütçe Gemini bütçesini ezer (acik > model)", () => {
    const state = firstTurn("2000 ile 3000 tl arası kask");
    expect(state.budget).toMatchObject({ minKurus: 200000, maxKurus: 300000 });
    const next = applyInterpretation(
      state,
      interpretation({ domainId: "helmet", budget: { minKurus: null, maxKurus: 200000 } }),
    );
    expect(next.budget).toMatchObject({ minKurus: 200000, maxKurus: 300000 });
  });

  it("deterministik domain korunur; başka domain'in nitelikleri atılır", () => {
    const state = firstTurn("kask");
    expect(state.domainId).toBe("helmet");
    const next = applyInterpretation(
      state,
      interpretation({
        domainId: "shoes",
        facets: [{ facetId: "shoe_type", optionId: "running" }],
      }),
    );
    expect(next.domainId).toBe("helmet");
    expect(next.facets).toEqual({});
  });

  it("eksik bilgi doldurulur: aynı domain'in niteliği ve bütçesi model kaynağıyla", () => {
    const state = firstTurn("kask");
    const next = applyInterpretation(
      state,
      interpretation({
        domainId: "helmet",
        facets: [{ facetId: "use_case", optionId: "city" }],
        budget: { minKurus: null, maxKurus: 300000 },
        pricePreference: "lower",
      }),
    );
    expect(next.facets.use_case).toMatchObject({ optionId: "city", source: "model" });
    expect(next.budget).toMatchObject({ maxKurus: 300000, source: "model" });
    expect(next.constraints.pricePreference).toBe("lower");
  });
});

describe("replayConversation firstTurnEnrichment", () => {
  const enrich = interpretation({
    domainId: "helmet",
    facets: [{ facetId: "use_case", optionId: "city" }],
  });

  it("varsayılan (saklanan yol): domain bulunduysa yorum uygulanmaz", () => {
    const { decision } = replayConversation([{ type: "text", text: "kask" }], context, {
      firstTurnInterpretation: enrich,
    });
    expect(decision.state.facets.use_case).toBeUndefined();
  });

  it("anlık yol: domain bulunsa da eksikleri doldurur", () => {
    const { decision } = replayConversation([{ type: "text", text: "kask" }], context, {
      firstTurnInterpretation: enrich,
      firstTurnEnrichment: true,
    });
    expect(decision.state.domainId).toBe("helmet");
    expect(decision.state.facets.use_case).toMatchObject({ optionId: "city", source: "model" });
  });

  it("sonraki açık kullanıcı cevabı model niteliğini ezer", () => {
    const { decision } = replayConversation(
      [
        { type: "text", text: "kask" },
        { type: "answer", questionId: "use_case", optionId: "touring" },
      ],
      context,
      { firstTurnInterpretation: enrich, firstTurnEnrichment: true },
    );
    expect(decision.state.facets.use_case).toMatchObject({ optionId: "touring" });
    expect(decision.state.facets.use_case?.source).not.toBe("model");
  });
});
