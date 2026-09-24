/**
 * Belirsizlik regresyon seti. Kural sozlugu veya hazirlik esikleri
 * degistiginde neyin bozuldugu burada gorunur (CLAUDE.md: eslestirme
 * mantigi icin regresyon seti zorunlu - ayni gerekce).
 */
import { describe, expect, it } from "vitest";
import { step } from "./engine.ts";
import { createInitialState } from "./state.ts";
import { TEST_CONTEXT } from "./test-fixtures.ts";

interface Case {
  query: string;
  action: "clarify" | "search";
  /** Beklenen soru (clarify ise). */
  question?: string;
  /** Bu sorular SORULMAMALI - zaten biliniyor. */
  notAsked?: readonly string[];
  /** Metinden cikmis olmasi gereken fasetler. */
  facets?: Readonly<Record<string, string>>;
  domain?: string | null;
  budget?: { minKurus: number | null; maxKurus: number | null };
}

const CASES: readonly Case[] = [
  { query: "kask arıyorum", action: "clarify", question: "helmet_type", domain: "helmet" },
  { query: "kask", action: "clarify", question: "helmet_type", domain: "helmet" },
  {
    query: "full face kask arıyorum",
    action: "clarify",
    question: "use_case",
    notAsked: ["helmet_type"],
    facets: { helmet_type: "full_face" },
  },
  { query: "full face siyah kask", action: "search", facets: { helmet_type: "full_face" } },
  { query: "bisiklet kaskı", action: "search", domain: null },
  { query: "telefon istiyorum", action: "clarify", question: "budget", domain: "phone" },
  { query: "iphone 16 kılıfı", action: "search", domain: null },
  { query: "telefon kılıfı", action: "search", domain: null },
  { query: "ayakkabı", action: "clarify", question: "shoe_type", domain: "shoes" },
  {
    query: "siyah erkek koşu ayakkabısı",
    action: "search",
    facets: { shoe_type: "running", audience: "men" },
  },
  { query: "nike air force 1 beyaz 42", action: "search", domain: null },
  { query: "hediye arıyorum", action: "clarify", question: "recipient", domain: "gift" },
  { query: "hediye", action: "clarify", question: "recipient", domain: "gift" },
  {
    query: "anneme hediye arıyorum",
    action: "clarify",
    question: "interest",
    notAsked: ["recipient"],
    facets: { recipient: "mother" },
  },
  {
    query: "1000 liraya anneme hediye",
    action: "clarify",
    question: "interest",
    notAsked: ["recipient", "budget"],
    facets: { recipient: "mother" },
    budget: { minKurus: null, maxKurus: 100000 },
  },
  {
    query: "500 liraya kız arkadaşıma hediye arıyorum",
    action: "clarify",
    question: "interest",
    notAsked: ["recipient", "budget"],
    facets: { recipient: "partner" },
    budget: { minKurus: null, maxKurus: 50000 },
  },
  {
    query: "erkek arkadaşıma doğum günü hediyesi",
    action: "clarify",
    question: "interest",
    notAsked: ["recipient"],
    facets: { recipient: "partner" },
  },
  {
    query: "10 yaşındaki çocuğa hediye",
    action: "clarify",
    question: "interest",
    notAsked: ["recipient", "age_band"],
    facets: { recipient: "child", age_band: "preteen" },
  },
  {
    query: "500 TL altında hediye",
    action: "clarify",
    question: "recipient",
    notAsked: ["budget"],
    budget: { minKurus: null, maxKurus: 50000 },
  },
  { query: "anneme hediye çanta", action: "search", facets: { recipient: "mother" } },
  { query: "masa lambası", action: "search", domain: null },
  { query: "evime bir şeyler bakıyorum", action: "clarify", question: "home_type", domain: "home" },
  { query: "ucuz mouse", action: "search", domain: null },
  { query: "500 TL altında erkek parfümü", action: "search", domain: null },
  {
    query: "kosu ayakkabisi",
    action: "clarify",
    question: "audience",
    facets: { shoe_type: "running" },
  },
];

describe("belirsizlik regresyon seti", () => {
  it.each(CASES)("$query -> $action", (testCase) => {
    const decision = step(
      createInitialState(),
      { type: "text", text: testCase.query },
      TEST_CONTEXT,
    );

    expect(decision.action).toBe(testCase.action);
    if (testCase.action === "clarify" && decision.action === "clarify") {
      expect(decision.question.id).toBe(testCase.question);
    }
    if (decision.action === "clarify") {
      for (const id of testCase.notAsked ?? []) expect(decision.question.id).not.toBe(id);
    }
    if (testCase.domain !== undefined) expect(decision.state.domainId).toBe(testCase.domain);
    for (const [facetId, optionId] of Object.entries(testCase.facets ?? {})) {
      expect(decision.state.facets[facetId]?.optionId).toBe(optionId);
    }
    if (testCase.budget) {
      expect(decision.state.budget).toMatchObject(testCase.budget);
    }
  });

  it('"ucuz" bir fiyata cevrilmez, yalnizca tercih olarak saklanir', () => {
    const decision = step(createInitialState(), { type: "text", text: "ucuz mouse" }, TEST_CONTEXT);
    expect(decision.state.budget).toBeNull();
    expect(decision.state.constraints.pricePreference).toBe("lower");
    expect(decision.state.terms).toEqual(["mouse"]);
  });

  it("sorulan hicbir soru bir turda birden fazla degil", () => {
    for (const testCase of CASES) {
      const decision = step(
        createInitialState(),
        { type: "text", text: testCase.query },
        TEST_CONTEXT,
      );
      if (decision.action === "clarify") {
        expect(Object.keys(decision.state.askCounts)).toHaveLength(1);
      }
    }
  });
});
