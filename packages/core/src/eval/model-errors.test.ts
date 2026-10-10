import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import type { InterpretationOutcome } from "../chat/interpreter.ts";
import type { LlmCall } from "../llm/client.ts";
import type { ModelInterpretationOutcome } from "../llm/intent-interpreter.ts";
import {
  failureFromChatTurn,
  failureFromInterpretation,
  recordModelFailure,
} from "./model-errors.ts";
import { classifyAiError } from "./store.ts";

const call = (httpStatus: number | null): LlmCall => ({
  modelVersion: "gemini-x",
  httpStatus,
  usage: null,
});
const cls = (e: Error | null) => (e ? classifyAiError(e) : null);

describe("failureFromInterpretation", () => {
  const base = { calls: [call(200)], modelVersion: "m" };

  it("basarili ve bos yorum hata degildir", () => {
    expect(
      failureFromInterpretation({ status: "empty", rejected: [], ...base } as never),
    ).toBeNull();
    expect(
      failureFromInterpretation({ status: "accepted", rejected: [], ...base } as never),
    ).toBeNull();
  });

  it.each([
    ["timeout", "timeout"],
    ["rate_limited", "rate_limited"],
    ["server_error", "server_error"],
    ["auth", "auth"],
    ["client_error", "bad_request"],
    ["network", "network"],
  ] as const)("saglayici hatasi %s -> %s", (code, expected) => {
    const out = {
      status: "provider_error",
      code,
      calls: [call(code === "rate_limited" ? 429 : null)],
      modelVersion: "m",
    } as ModelInterpretationOutcome;
    expect(cls(failureFromInterpretation(out))?.errorClass).toBe(expected);
  });

  it("HTTP durumu son denemeden gelir", () => {
    const out = {
      status: "provider_error",
      code: "rate_limited",
      calls: [call(500), call(429)],
      modelVersion: "m",
    } as ModelInterpretationOutcome;
    expect(cls(failureFromInterpretation(out))?.httpStatus).toBe(429);
  });

  it("gecersiz JSON ve kesik cikti ayri siniflanir", () => {
    const invalidJson = {
      status: "invalid",
      rejected: [{ path: "$", reason: "invalid_json" }],
      ...base,
    } as ModelInterpretationOutcome;
    const incomplete = {
      status: "invalid",
      rejected: [{ path: "$", reason: "incomplete" }],
      ...base,
    } as ModelInterpretationOutcome;
    expect(cls(failureFromInterpretation(invalidJson))?.errorClass).toBe("schema_invalid");
    expect(cls(failureFromInterpretation(incomplete))?.errorClass).toBe("empty_output");
  });

  it("guvenlik filtresi durum degeri safety_blocked olur", () => {
    const out = {
      status: "invalid",
      rejected: [{ path: "$", reason: "incomplete" }],
      errorDetail: "SAFETY",
      ...base,
    } as ModelInterpretationOutcome;
    expect(cls(failureFromInterpretation(out))?.errorClass).toBe("safety_blocked");
  });

  it("alan dogrulama reddi schema_invalid", () => {
    const out = {
      status: "invalid",
      rejected: [{ path: "$.facets[0]", reason: "unknown_facet" }],
      ...base,
    } as ModelInterpretationOutcome;
    expect(cls(failureFromInterpretation(out))?.errorClass).toBe("schema_invalid");
  });

  it("siniflanamayan hata unknown olur", () => {
    const out = {
      status: "provider_error",
      code: "unknown",
      calls: [],
      modelVersion: "m",
    } as ModelInterpretationOutcome;
    expect(cls(failureFromInterpretation(out))?.errorClass).toBe("unknown");
  });
});

describe("failureFromChatTurn", () => {
  const turn = (fallbackReason: string | null, extra = {}) =>
    ({
      kind: "turn",
      source: "fallback",
      fallbackReason,
      calls: [call(200)],
      modelVersion: "m",
      ...extra,
    }) as unknown as InterpretationOutcome;

  it("model yaniti kullanilmis ya da model kullanilmamissa hata yok", () => {
    expect(failureFromChatTurn(turn(null))).toBeNull();
    for (const reason of ["filtered", "daily_cap", "clarify_limit", "no_query"]) {
      expect(failureFromChatTurn(turn(reason))).toBeNull();
    }
  });

  it("cikti hatasi kodunu ve durum degerini korur", () => {
    const e = failureFromChatTurn(
      turn("output_error", { modelError: { code: "incomplete", detail: "MAX_TOKENS" } }),
    );
    expect(cls(e)?.errorClass).toBe("empty_output");
  });

  it("yapilandirilmis yanit dogrulama hatasi schema_invalid", () => {
    expect(cls(failureFromChatTurn(turn("bad_action")))?.errorClass).toBe("schema_invalid");
  });

  it("saglayici hatasi (rate limit)", () => {
    const e = failureFromChatTurn({
      kind: "provider_error",
      code: "rate_limited",
      calls: [call(429)],
      modelVersion: "m",
    });
    expect(cls(e)).toEqual({ errorClass: "rate_limited", httpStatus: 429 });
  });
});

describe("recordModelFailure", () => {
  const failing = {
    insert: () => {
      throw new Error("db down");
    },
  } as unknown as Database;
  const input = { operation: "chat_turn", surface: "chat" as const, modelVersion: "m" };

  it("hata yoksa hicbir sey yazmaz ve veritabanina dokunmaz", async () => {
    const untouchable = new Proxy({} as Database, {
      get() {
        throw new Error("erisildi");
      },
    });
    expect(await recordModelFailure(untouchable, { ...input, failure: null })).toBe(false);
  });

  it("kayit sistemi cokerse firlatmaz", async () => {
    await expect(recordModelFailure(failing, { ...input, failure: new Error("x") })).resolves.toBe(
      false,
    );
  });

  it("kayit sistemi asilirsa sure sinirinda birakir", async () => {
    const hanging = {
      insert: () => ({ values: () => new Promise(() => {}) }),
    } as unknown as Database;
    const started = Date.now();
    const ok = await recordModelFailure(hanging, {
      ...input,
      failure: new Error("x"),
      timeoutMs: 50,
    });
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
