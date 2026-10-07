import { describe, expect, it, vi } from "vitest";
import { type LlmCall, LlmError, type LlmJsonResult } from "../llm/client.ts";
import { emptyIntent } from "./intent.ts";
import {
  buildChatInput,
  type ChatInterpreter,
  fallbackTurn,
  type InterpretRequest,
  interpretTurn,
  isBlockedFromModel,
} from "./interpreter.ts";

const USAGE = { inputTokens: 10, outputTokens: 5, thoughtTokens: 0, totalTokens: 15 };

function request(overrides: Partial<InterpretRequest> = {}): InterpretRequest {
  return {
    messages: [{ role: "user", kind: "text", text: "ayakkabı arıyorum" }],
    currentIntent: null,
    pendingQuestion: null,
    clarifyCount: 0,
    input: { kind: "text", text: "ayakkabı arıyorum" },
    ...overrides,
  };
}

function interpreterReturning(value: unknown): ChatInterpreter & { calls: number } {
  const state = { calls: 0 };
  return {
    modelVersion: "test-model",
    get calls() {
      return state.calls;
    },
    async interpret(_request, options) {
      state.calls++;
      const call: LlmCall = { modelVersion: "test-model", httpStatus: 200, usage: USAGE };
      options?.onCall?.(call);
      const result: LlmJsonResult = { value, usage: USAGE, modelVersion: "test-model" };
      return result;
    },
  };
}

const CLARIFY = {
  action: "clarify",
  message: "Ne tür ayakkabı?",
  question: {
    id: "shoe_type",
    title: "Ne tür ayakkabı?",
    options: [
      { label: "Günlük", description: null, value: "casual" },
      { label: "Koşu", description: null, value: "running" },
    ],
  },
  intent: null,
};
const SEARCH = (query = "spor ayakkabı") => ({
  action: "search",
  message: "Arıyorum.",
  question: null,
  intent: { reset: false, query, remove: [] },
});

describe("interpretTurn", () => {
  it("returns a validated clarify turn from the model", async () => {
    const outcome = await interpretTurn(interpreterReturning(CLARIFY), request());
    expect(outcome).toMatchObject({ kind: "turn", source: "model", turn: { action: "clarify" } });
    if (outcome.kind === "turn") expect(outcome.calls).toHaveLength(1);
  });

  it("returns a validated search turn from the model", async () => {
    const outcome = await interpretTurn(interpreterReturning(SEARCH()), request());
    expect(outcome).toMatchObject({ kind: "turn", source: "model", turn: { action: "search" } });
  });

  it("falls back to a plain search when the output is malformed", async () => {
    const outcome = await interpretTurn(
      interpreterReturning({ action: "drop table", message: "x" }),
      request(),
    );
    expect(outcome).toMatchObject({
      kind: "turn",
      source: "fallback",
      fallbackReason: "bad_action",
    });
    if (outcome.kind === "turn" && outcome.turn.action === "search") {
      expect(outcome.turn.intent.query).toBe("ayakkabı arıyorum");
    } else {
      throw new Error("fallback must be a search");
    }
  });

  it("falls back when the response is truncated or not JSON", async () => {
    for (const code of ["incomplete", "invalid_json", "malformed_response"] as const) {
      const outcome = await interpretTurn(
        {
          modelVersion: "m",
          interpret: async () => {
            throw new LlmError(code);
          },
        },
        request(),
      );
      expect(outcome).toMatchObject({
        kind: "turn",
        source: "fallback",
        fallbackReason: "output_error",
      });
    }
  });

  it("reports provider failures instead of inventing an answer", async () => {
    for (const code of ["timeout", "rate_limited", "missing_api_key", "auth"] as const) {
      const outcome = await interpretTurn(
        {
          modelVersion: "m",
          interpret: async () => {
            throw new LlmError(code);
          },
        },
        request(),
      );
      expect(outcome).toMatchObject({ kind: "provider_error", code });
    }
  });

  it("never throws on unexpected errors", async () => {
    const outcome = await interpretTurn(
      {
        modelVersion: "m",
        interpret: async () => {
          throw new Error("boom");
        },
      },
      request(),
    );
    expect(outcome).toMatchObject({ kind: "provider_error", code: "unknown" });
  });

  it("enforces the consecutive-question cap: a third question becomes a search", async () => {
    const outcome = await interpretTurn(
      interpreterReturning(CLARIFY),
      request({
        clarifyCount: 2,
        messages: [
          { role: "user", kind: "text", text: "ayakkabı" },
          { role: "assistant", kind: "clarify", text: "q1" },
          { role: "user", kind: "text", text: "spor" },
          { role: "assistant", kind: "clarify", text: "q2" },
          { role: "user", kind: "text", text: "günlük" },
        ],
        input: { kind: "text", text: "günlük" },
      }),
    );
    expect(outcome).toMatchObject({
      kind: "turn",
      source: "fallback",
      fallbackReason: "clarify_limit",
    });
  });

  it("does not re-ask after the user skipped", async () => {
    const outcome = await interpretTurn(
      interpreterReturning(CLARIFY),
      request({ input: { kind: "skip", questionId: "shoe_type" } }),
    );
    expect(outcome).toMatchObject({ kind: "turn", fallbackReason: "clarify_limit" });
  });

  it("falls back when a first-turn search patch has no query", async () => {
    const outcome = await interpretTurn(
      interpreterReturning({
        action: "search",
        message: "ok",
        question: null,
        intent: { reset: false, brand: "Nike", remove: [] },
      }),
      request(),
    );
    expect(outcome).toMatchObject({ kind: "turn", source: "fallback", fallbackReason: "no_query" });
  });

  it("never sends a sensitive message to the model", async () => {
    const model = interpreterReturning(SEARCH());
    const outcome = await interpretTurn(model, {
      ...request(),
      messages: [{ role: "user", kind: "text", text: "hamile pantolonu" }],
      input: { kind: "text", text: "hamile pantolonu" },
    });
    expect(model.calls).toBe(0);
    expect(outcome).toMatchObject({ kind: "turn", source: "fallback", fallbackReason: "filtered" });
  });

  it("redacts earlier blocked messages from the transcript sent to the model", async () => {
    const seen: string[] = [];
    const model: ChatInterpreter = {
      modelVersion: "m",
      interpret: async (req) => {
        seen.push(buildChatInput(req));
        return { value: SEARCH(), usage: USAGE, modelVersion: "m" };
      },
    };
    await interpretTurn(model, {
      ...request(),
      messages: [
        { role: "user", kind: "text", text: "hamile pantolonu" },
        { role: "assistant", kind: "search", text: "Aradım." },
        { role: "user", kind: "text", text: "siyah olsun" },
      ],
      input: { kind: "text", text: "siyah olsun" },
    });
    expect(seen[0]).toContain("[gösterilmedi]");
    expect(seen[0]).not.toContain("hamile");
  });
});

describe("buildChatInput", () => {
  it("carries messages, intent and open question but no identity fields", () => {
    const input = buildChatInput(
      request({
        currentIntent: emptyIntent("ayakkabı"),
        pendingQuestion: { id: "q", title: "Soru?" },
      }),
    );
    const parsed = JSON.parse(input);
    expect(Object.keys(parsed).sort()).toEqual([
      "clarify_count",
      "current_intent",
      "messages",
      "open_question",
    ]);
    expect(input).not.toMatch(/user_?id|email|session|ip/i);
  });

  it("caps the transcript at the most recent messages", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      kind: "text" as const,
      text: `m${i}`,
    }));
    const parsed = JSON.parse(buildChatInput(request({ messages })));
    expect(parsed.messages).toHaveLength(12);
    expect(parsed.messages.at(-1).text).toBe("m29");
  });
});

describe("isBlockedFromModel", () => {
  it.each([
    ["hamile pantolonu", true],
    ["benim telefonum 0532 123 45 67 ve tc 12345678901", true],
    ["api_key=abcdef", true],
    ["siyah spor ayakkabı 2500 tl altı", false],
    ["nike olsun", false],
    ["", false],
  ])("%s -> %s", (text, blocked) => {
    expect(isBlockedFromModel(text)).toBe(blocked);
  });

  it("checks long messages in chunks", () => {
    const long = `${"siyah ayakkabı ".repeat(30)} hamile pantolonu`;
    expect(isBlockedFromModel(long)).toBe(true);
    expect(isBlockedFromModel("siyah ayakkabı ".repeat(30))).toBe(false);
  });
});

describe("fallbackTurn", () => {
  const searchPatch = (r: InterpretRequest) => {
    const turn = fallbackTurn(r);
    if (turn.action !== "search") throw new Error("fallback must search");
    return turn.intent;
  };

  it("first message is searched as typed", () => {
    expect(searchPatch(request()).query).toBe("ayakkabı arıyorum");
  });

  it("an option answer extends the original query with the option label", () => {
    const patch = searchPatch(
      request({
        messages: [
          { role: "user", kind: "text", text: "ayakkabı arıyorum" },
          { role: "assistant", kind: "clarify", text: "Ne tür?" },
          { role: "user", kind: "option", text: "Koşu" },
        ],
        input: { kind: "option", questionId: "q", value: "running", label: "Koşu" },
      }),
    );
    expect(patch.query).toBe("ayakkabı arıyorum Koşu");
  });

  it("a custom text answer to a question also extends the original query", () => {
    const patch = searchPatch(
      request({
        messages: [
          { role: "user", kind: "text", text: "ayakkabı" },
          { role: "assistant", kind: "clarify", text: "Ne tür?" },
          { role: "user", kind: "text", text: "trekking" },
        ],
        input: { kind: "text", text: "trekking" },
      }),
    );
    expect(patch.query).toBe("ayakkabı trekking");
  });

  it("a skip keeps the query as is", () => {
    const patch = searchPatch(
      request({
        messages: [
          { role: "user", kind: "text", text: "ayakkabı" },
          { role: "assistant", kind: "clarify", text: "Ne tür?" },
          { role: "user", kind: "skip", text: "(soruyu atladı)" },
        ],
        input: { kind: "skip", questionId: "q" },
      }),
    );
    expect(patch.query).toBe("ayakkabı");
  });

  it("refinement extracts a price cap and the cheaper preference deterministically", () => {
    const patch = searchPatch(
      request({
        currentIntent: emptyIntent("spor ayakkabı"),
        messages: [{ role: "user", kind: "text", text: "2500 TL altı daha uygun olsun" }],
        input: { kind: "text", text: "2500 TL altı daha uygun olsun" },
      }),
    );
    expect(patch.priceMax).toBe(2500);
    expect(patch.sort).toBe("cheapest");
    expect(patch.query).toBe("spor ayakkabı olsun");
  });

  it("is never empty and never exceeds the query limit", () => {
    const patch = searchPatch(
      request({
        input: { kind: "text", text: "x".repeat(400) },
        messages: [{ role: "user", kind: "text", text: "x".repeat(400) }],
      }),
    );
    expect(patch.query?.length).toBeLessThanOrEqual(120);
    expect(patch.query?.length).toBeGreaterThan(0);
  });
});

describe("interpretTurn accounting", () => {
  it("reports every HTTP attempt, including failed ones", async () => {
    const onCall = vi.fn();
    const outcome = await interpretTurn(
      {
        modelVersion: "m",
        interpret: async (_r, options) => {
          options?.onCall?.({ modelVersion: "m", httpStatus: 429, usage: null });
          options?.onCall?.({ modelVersion: "m", httpStatus: 200, usage: USAGE });
          onCall();
          return { value: SEARCH(), usage: USAGE, modelVersion: "m" };
        },
      },
      request(),
    );
    expect(outcome.calls).toHaveLength(2);
  });
});
