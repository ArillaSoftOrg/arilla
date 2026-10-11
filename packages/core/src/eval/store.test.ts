import { describe, expect, it } from "vitest";
import { EmbeddingError } from "../embedding/client.ts";
import { LlmError } from "../llm/client.ts";
import { caseKey, classifyAiError, datasetFingerprint } from "./store.ts";

describe("classifyAiError", () => {
  it("LlmError kodlarini sabit siniflara esler", () => {
    expect(classifyAiError(new LlmError("rate_limited", 429))).toEqual({
      errorClass: "rate_limited",
      httpStatus: 429,
    });
    expect(classifyAiError(new LlmError("invalid_json")).errorClass).toBe("schema_invalid");
    expect(classifyAiError(new LlmError("incomplete", 200, "MAX_TOKENS")).errorClass).toBe(
      "empty_output",
    );
    expect(classifyAiError(new LlmError("missing_api_key")).errorClass).toBe("auth");
  });

  it("zaman asimi ve ag hatalarini ayirir", () => {
    const abort = Object.assign(new Error("x"), { name: "TimeoutError" });
    expect(classifyAiError(abort).errorClass).toBe("timeout");
    expect(classifyAiError(new Error("fetch failed")).errorClass).toBe("network");
  });

  it("Jina hatasinda HTTP durumundan sinif cikarir", () => {
    expect(classifyAiError(new EmbeddingError("jina HTTP 503")).errorClass).toBe("server_error");
    expect(classifyAiError(new EmbeddingError("jina status 401")).errorClass).toBe("auth");
  });

  it("taninmayani unknown yapar, cokmez", () => {
    expect(classifyAiError(undefined).errorClass).toBe("unknown");
    expect(classifyAiError("garip").errorClass).toBe("unknown");
  });
});

describe("caseKey / datasetFingerprint", () => {
  it("kararli, kisa ve metni sizdirmaz", () => {
    const key = caseKey("intent", "kask arıyorum");
    expect(key).toMatch(/^[0-9a-f]{24}$/);
    expect(key).toBe(caseKey("intent", "  kask arıyorum "));
    expect(key).not.toBe(caseKey("search", "kask arıyorum"));
    expect(key).not.toContain("kask");
  });

  it("parmak izi anahtar sirasindan bagimsiz, icerikten bagimli", () => {
    expect(datasetFingerprint({ a: 1, b: [1, 2] })).toBe(datasetFingerprint({ b: [1, 2], a: 1 }));
    expect(datasetFingerprint({ a: 1 })).not.toBe(datasetFingerprint({ a: 2 }));
  });
});
