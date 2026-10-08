/**
 * Ayakkabi metin kapisi regresyon seti. SHOES bas ismi tek bir alternatif
 * slotudur: [ayakkabi | sneaker | loafer]. Onceden "spor ayakkabı" kapiyi
 * [["sneaker"], ["ayakkabi"]] olarak kuruyor, basliginda yalnizca "sneaker"
 * gecen urunleri disarida birakiyordu. "spor" bilerek alternatif DEGIL:
 * "spor" baslikta esofmandan matara'ya kadar her seyde gecer.
 *
 * "sneaker" iceren sorgular SHOES domain'ini tetiklemez (tetikleyici
 * "ayakkabı*"); bunlar konvansiyonel ayristirmadan gecer ve bu degisiklikten
 * etkilenmemeli.
 */
import { describe, expect, it } from "vitest";
import { type ConversationPlan, planConversation } from "../conversational-search/plan.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { textSlotsOf } from "../search/search-sql.ts";
import type { ValidatedInterpretation } from "./interpreter.ts";
import { TEST_CONTEXT, TEST_LEXICON } from "./test-fixtures.ts";

const SHOE_HEAD = ["ayakkabi", "sneaker", "loafer"];

type Conversation = Extract<ConversationPlan, { mode: "conversation" }>;

function conversation(query: string, steps: readonly string[] = []): Conversation {
  const plan = planConversation({ query, steps, reply: null }, TEST_CONTEXT);
  if (plan.mode !== "conversation") throw new Error(`conversation bekleniyordu: ${plan.reason}`);
  return plan;
}

describe("ayakkabı domain'i: baş isim tek alternatif slotu", () => {
  const cases: readonly {
    query: string;
    slots: string[][];
    color?: string[];
  }[] = [
    { query: "ayakkabı", slots: [SHOE_HEAD] },
    { query: "siyah ayakkabı", slots: [SHOE_HEAD], color: ["black"] },
    // "spor" -> shoe_type=sneaker -> "sneaker" bas slota katilir, ayri zorunlu slot olmaz.
    { query: "spor ayakkabı", slots: [SHOE_HEAD] },
    { query: "koşu ayakkabısı", slots: [["kosu"], SHOE_HEAD] },
  ];

  for (const { query, slots, color } of cases) {
    it(query, () => {
      const plan = conversation(query);
      expect(plan.queryObject.text_slots).toBeDefined();
      expect(textSlotsOf(plan.queryObject)).toEqual(slots);
      expect(plan.queryObject.filters.color).toEqual(color);
    });
  }

  it('"spor" alternatif değil', () => {
    const slots = textSlotsOf(conversation("spor ayakkabı").queryObject);
    expect(slots.flat()).not.toContain("spor");
  });

  it("ayakkabı -> Spor / sneaker seçimi aynı baş slotla arar", () => {
    const plan = conversation("ayakkabı", ["a~shoe_type~sneaker"]);
    expect(textSlotsOf(plan.queryObject)).toEqual([SHOE_HEAD]);
  });
});

describe("saklanan model yorumu: siyah sneaker -> shoes / Spor / sneaker (üretim yolu)", () => {
  // Uretimde "siyah sneaker" icin saklanan Gemini yorumu bu; model cagrilmaz.
  const SHOES_SNEAKER: ValidatedInterpretation = {
    domainId: "shoes",
    facets: [{ facetId: "shoe_type", optionId: "sneaker" }],
    budget: null,
    pricePreference: null,
  };

  // Saklanan yol (`planConversationWithInterpretationSource`) ve anlik yol
  // (`firstTurnEnrichment`) ayni kapiyi kurmali.
  for (const [name, replay] of [
    ["saklanan", { firstTurnInterpretation: SHOES_SNEAKER }],
    ["anlık", { firstTurnInterpretation: SHOES_SNEAKER, firstTurnEnrichment: true }],
  ] as const) {
    it(`${name}: baş slot [ayakkabi | sneaker | loafer], ikisi birden zorunlu değil`, () => {
      const plan = planConversation(
        { query: "siyah sneaker", steps: [], reply: null },
        TEST_CONTEXT,
        {},
        replay,
      );
      if (plan.mode !== "conversation")
        throw new Error(`conversation bekleniyordu: ${plan.reason}`);
      const slots = textSlotsOf(plan.queryObject);
      expect(slots).toEqual([SHOE_HEAD]);
      // Hicbir slot yalnizca "sneaker" ya da yalnizca "ayakkabi" degil.
      expect(slots).not.toContainEqual(["sneaker"]);
      expect(slots).not.toContainEqual(["ayakkabi"]);
      expect(plan.queryObject.filters.color).toEqual(["black"]);
    });
  }

  it("üretim sözlüğü biçimi: 'siyah' renk değilse metin niteleyicisi kalır", () => {
    // Uretim tanisinda (2026-10-08) "siyah" renk suzgecine donmuyor, kalan
    // metinde kaliyor; sneaker ise es anlamli olarak eslesiyor.
    const lexicon: readonly LexiconEntry[] = [
      { kind: "synonym", surface: "sneaker", normalized: "sneaker", weight: 1 },
      { kind: "synonym", surface: "spor ayakkabı", normalized: "sneaker", weight: 1 },
    ];
    const plan = planConversation(
      { query: "siyah sneaker", steps: [], reply: null },
      { ...TEST_CONTEXT, lexicon },
      {},
      { firstTurnInterpretation: SHOES_SNEAKER },
    );
    if (plan.mode !== "conversation") throw new Error(`conversation bekleniyordu: ${plan.reason}`);
    expect(textSlotsOf(plan.queryObject)).toEqual([["siyah"], SHOE_HEAD]);
    expect(plan.queryObject.filters.color).toBeUndefined();
  });
});

describe("sneaker sorguları domain'siz ayrıştırılır (değişmez)", () => {
  const cases: readonly { query: string; slots: string[][]; color?: string[] }[] = [
    { query: "sneaker", slots: [["sneaker"]] },
    { query: "siyah sneaker", slots: [["sneaker"]], color: ["black"] },
    { query: "erkek sneaker", slots: [["erkek"], ["sneaker"]] },
    { query: "kadın sneaker", slots: [["kadin"], ["sneaker"]] },
  ];

  for (const { query, slots, color } of cases) {
    it(query, () => {
      const plan = planConversation({ query, steps: [], reply: null }, TEST_CONTEXT);
      expect(plan.mode).toBe("conventional");
      const parsed = parseQueryText(query, TEST_LEXICON);
      expect(textSlotsOf(parsed)).toEqual(slots);
      expect(parsed.filters.color).toEqual(color);
    });
  }
});
