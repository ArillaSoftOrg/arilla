import { describe, expect, it } from "vitest";
import { buildModelTurnSchema, cleanText, parseModelTurn } from "./contract.ts";

const CLARIFY = {
  action: "clarify",
  message: "Ne tür ayakkabı arıyorsunuz?",
  question: {
    id: "shoe_type",
    title: "Ne tür ayakkabı arıyorsunuz?",
    options: [
      {
        label: "Spor ayakkabı / günlük",
        description: "Rahat günlük modeller",
        value: "casual_sneaker",
      },
      { label: "Koşu / spor", description: "Antrenman ve performans", value: "running" },
      { label: "Deri / şık", description: null, value: "formal" },
      { label: "Bot", description: null, value: "boots" },
    ],
    allowCustomAnswer: true,
    skippable: true,
  },
  intent: null,
};

const SEARCH = {
  action: "search",
  message: "Günlük spor ayakkabılara bakıyorum.",
  question: null,
  intent: {
    reset: false,
    query: "günlük spor ayakkabı",
    category: "ayakkabı",
    brand: null,
    excludeBrands: [],
    colors: [],
    size: null,
    priceMin: null,
    priceMax: null,
    attributes: [
      { key: "usage", value: "günlük" },
      { key: "style", value: "spor" },
    ],
    sort: null,
    remove: [],
  },
};

describe("parseModelTurn", () => {
  it("accepts a clarify turn and always keeps custom answer and skip available", () => {
    const parsed = parseModelTurn({
      ...CLARIFY,
      question: { ...CLARIFY.question, allowCustomAnswer: false, skippable: false },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.turn.action !== "clarify") throw new Error("unreachable");
    expect(parsed.turn.question.id).toBe("shoe_type");
    expect(parsed.turn.question.options).toHaveLength(4);
    expect(parsed.turn.question.allowCustomAnswer).toBe(true);
    expect(parsed.turn.question.skippable).toBe(true);
    expect(parsed.turn.question.options[2]).toEqual({ label: "Deri / şık", value: "formal" });
  });

  it("accepts a search turn and normalizes the attributes list into a record", () => {
    const parsed = parseModelTurn(SEARCH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.turn.action !== "search") throw new Error("unreachable");
    expect(parsed.turn.intent).toEqual({
      reset: false,
      query: "günlük spor ayakkabı",
      category: "ayakkabı",
      attributes: { usage: "günlük", style: "spor" },
      remove: [],
    });
  });

  it("accepts the object form of attributes (spec example)", () => {
    const parsed = parseModelTurn({
      ...SEARCH,
      intent: { ...SEARCH.intent, attributes: { usage: "günlük" } },
    });
    expect(parsed.ok && parsed.turn.action === "search" && parsed.turn.intent.attributes).toEqual({
      usage: "günlük",
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "search"],
    ["unknown action", { ...SEARCH, action: "sql" }],
    ["missing message", { ...SEARCH, message: "  " }],
    ["clarify without question", { ...CLARIFY, question: null }],
    [
      "one option",
      { ...CLARIFY, question: { ...CLARIFY.question, options: [CLARIFY.question.options[0]] } },
    ],
    [
      "duplicate option values",
      {
        ...CLARIFY,
        question: {
          ...CLARIFY.question,
          options: [CLARIFY.question.options[0], CLARIFY.question.options[0]],
        },
      },
    ],
    ["search without intent", { ...SEARCH, intent: null }],
    ["search without query", { ...SEARCH, intent: { ...SEARCH.intent, query: "   " } }],
    ["negative price", { ...SEARCH, intent: { ...SEARCH.intent, priceMax: -5 } }],
    ["price as text", { ...SEARCH, intent: { ...SEARCH.intent, priceMax: "2500" } }],
    ["huge price", { ...SEARCH, intent: { ...SEARCH.intent, priceMax: 1e12 } }],
    ["unknown sort", { ...SEARCH, intent: { ...SEARCH.intent, sort: "random" } }],
    ["colors not a list", { ...SEARCH, intent: { ...SEARCH.intent, colors: "siyah" } }],
  ])("rejects malformed output: %s", (_name, value) => {
    expect(parseModelTurn(value).ok).toBe(false);
  });

  it("drops unknown removable fields instead of trusting them", () => {
    const parsed = parseModelTurn({
      ...SEARCH,
      intent: { ...SEARCH.intent, remove: ["brand", "sql", "query", "priceMax"] },
    });
    expect(parsed.ok && parsed.turn.action === "search" && parsed.turn.intent.remove).toEqual([
      "brand",
      "priceMax",
    ]);
  });

  it("strips control characters and truncates over-long text", () => {
    expect(cleanText("a\u0000b\nc", 10)).toBe("a b c");
    expect(cleanText("x".repeat(500), 100)?.length).toBe(100);
    expect(cleanText("   ", 10)).toBeNull();
    expect(cleanText(42, 10)).toBeNull();
  });

  it("ignores extra fields a model might add (no passthrough to state)", () => {
    const parsed = parseModelTurn({
      ...SEARCH,
      sql: "DROP TABLE product",
      intent: { ...SEARCH.intent, products: [{ id: 1 }], url: "https://x.test" },
    });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/DROP TABLE|products|x\.test/);
  });
});

describe("buildModelTurnSchema", () => {
  it("requires every top-level property and closes additional properties", () => {
    const schema = buildModelTurnSchema() as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["action", "message", "question", "intent"]);
    expect(schema.properties.action?.enum).toEqual(["clarify", "search"]);
  });
});
