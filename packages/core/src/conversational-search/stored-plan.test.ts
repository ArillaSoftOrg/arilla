/**
 * Saklanan model yorumunun konusma planina etkisi (kararlar 0030, 0059).
 * Saf: veritabani ve model yok; yorum dogrudan verilir.
 */
import { describe, expect, it } from "vitest";
import { replayConversation } from "../clarification/engine.ts";
import type { ValidatedInterpretation } from "../clarification/interpreter.ts";
import { TEST_CONTEXT } from "../clarification/test-fixtures.ts";
import { appendInput } from "../clarification/url-state.ts";
import { firstTurnFindsDomain, planConversation } from "./plan.ts";

const HELMET_FULL_FACE: ValidatedInterpretation = {
  domainId: "helmet",
  facets: [{ facetId: "helmet_type", optionId: "full_face" }],
  budget: null,
  pricePreference: null,
};

function plan(query: string, stored: ValidatedInterpretation | null, steps: string[] = []) {
  return planConversation({ query, steps }, TEST_CONTEXT, {}, { firstTurnInterpretation: stored });
}

function firstState(text: string, stored: ValidatedInterpretation | null) {
  return replayConversation([{ type: "text", text }], TEST_CONTEXT, {
    firstTurnInterpretation: stored,
  }).decision.state;
}

describe("saklanan yorum yoksa davranis birebir ayni", () => {
  it.each(["lumbarzyx", "kask", "kask 2000 tl alti", "lumbarzyx 2000 tl alti", "babama hediye"])(
    "%s",
    (query) => {
      const baseline = planConversation({ query, steps: [] }, TEST_CONTEXT);
      expect(plan(query, null)).toEqual(baseline);
      expect(planConversation({ query, steps: [] }, TEST_CONTEXT, {}, {})).toEqual(baseline);
    },
  );

  it("domain bulunamayan sorgu bugun oldugu gibi conventional/no_domain", () => {
    expect(plan("lumbarzyx", null)).toMatchObject({ mode: "conventional", reason: "no_domain" });
  });
});

describe("oncelik", () => {
  it("deterministik domain varsa saklanan yorum hic uygulanmaz", () => {
    expect(firstTurnFindsDomain("kask", TEST_CONTEXT)).toBe(true);
    const shoes: ValidatedInterpretation = {
      domainId: "shoes",
      facets: [],
      budget: null,
      pricePreference: "lower",
    };
    expect(plan("kask", shoes)).toEqual(
      planConversation({ query: "kask", steps: [] }, TEST_CONTEXT),
    );
    // Kullanicinin kendi metninden gelen domain `explicit`; modelin "lower" tercihi de girmedi.
    expect(firstState("kask", shoes)).toMatchObject({
      domainId: "helmet",
      domainSource: "explicit",
      constraints: { pricePreference: null },
    });
  });

  it("domain yoksa yorum en dusuk oncelikle eksik alanlari doldurur", () => {
    expect(firstTurnFindsDomain("lumbarzyx", TEST_CONTEXT)).toBe(false);
    const state = firstState("lumbarzyx", HELMET_FULL_FACE);
    expect(state.domainId).toBe("helmet");
    expect(state.domainSource).toBe("model");
    expect(state.facets.helmet_type).toMatchObject({ optionId: "full_face", source: "model" });

    const result = plan("lumbarzyx", HELMET_FULL_FACE);
    expect(result.mode).toBe("conversation");
    if (result.mode !== "conversation") return;
    expect(result.constraints.map((chip) => chip.key)).toContain("facet:helmet_type");
    expect(result.query).toBe("lumbarzyx");
  });

  it("acik kullanici cevabi saklanan faseti ezer", () => {
    const steps = appendInput([], {
      type: "answer",
      questionId: "helmet_type",
      optionId: "open_face",
    });
    const result = plan("lumbarzyx", HELMET_FULL_FACE, steps);
    expect(result.mode).toBe("conversation");
    if (result.mode !== "conversation") return;
    const replayed = replayConversation(
      [
        { type: "text", text: "lumbarzyx" },
        { type: "answer", questionId: "helmet_type", optionId: "open_face" },
      ],
      TEST_CONTEXT,
      { firstTurnInterpretation: HELMET_FULL_FACE },
    ).decision.state;
    expect(replayed.facets.helmet_type).toMatchObject({
      optionId: "open_face",
      source: "explicit",
    });
    expect(result.droppedInvalidStep).toBe(false);
  });

  it("kullanicinin atladigi faset modelle geri doldurulmaz", () => {
    const replayed = replayConversation(
      [
        { type: "text", text: "lumbarzyx" },
        { type: "skip", questionId: "helmet_type" },
      ],
      TEST_CONTEXT,
      { firstTurnInterpretation: HELMET_FULL_FACE },
    ).decision.state;
    expect(replayed.skippedFacets).toContain("helmet_type");
    expect(replayed.facets.helmet_type).toBeUndefined();
  });

  it("deterministik (acik) butce saklanan butceyi ezer", () => {
    const withBudget: ValidatedInterpretation = {
      ...HELMET_FULL_FACE,
      budget: { minKurus: null, maxKurus: 100_000 },
    };
    const state = firstState("lumbarzyx 1000 2000 tl alti", withBudget);
    expect(state.budget).toMatchObject({ maxKurus: 200_000, source: "explicit" });
  });

  it("saklanan yorum yalnizca ilk turda; yeni arama baslatan yanit onu tasimaz", () => {
    const replayed = replayConversation(
      [
        { type: "text", text: "lumbarzyx" },
        { type: "text", text: "spor ayakkabi lazim" },
      ],
      TEST_CONTEXT,
      { firstTurnInterpretation: HELMET_FULL_FACE },
    ).decision.state;
    expect(replayed.facets.helmet_type).toBeUndefined();
  });
});
