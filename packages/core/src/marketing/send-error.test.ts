import { describe, expect, it } from "vitest";
import { MarketingConfigError } from "./config.ts";
import { classifySendError, retryDelayMs } from "./send-error.ts";

function smtpError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("smtp hata: alici@ornek.com reddedildi"), fields);
}

describe("classifySendError", () => {
  it("treats auth/TLS/config problems as configuration (delivery not consumed)", () => {
    expect(classifySendError(smtpError({ code: "EAUTH", responseCode: 535 })).kind).toBe(
      "configuration",
    );
    expect(classifySendError(smtpError({ code: "ETLS" })).kind).toBe("configuration");
    expect(classifySendError(new MarketingConfigError("x")).kind).toBe("configuration");
  });

  it("retries explicit 4xx refusals and pre-connection failures", () => {
    expect(classifySendError(smtpError({ code: "EENVELOPE", responseCode: 451 }))).toEqual({
      kind: "retryable",
      providerCode: "EENVELOPE_451",
    });
    expect(classifySendError(smtpError({ code: "ECONNECTION" })).kind).toBe("retryable");
    expect(classifySendError(smtpError({ code: "ETIMEDOUT", command: "CONN" })).kind).toBe(
      "retryable",
    );
    expect(classifySendError(smtpError({ code: "ESOCKET", command: "RCPT TO" })).kind).toBe(
      "retryable",
    );
  });

  it("marks recipient 5xx as invalid recipient and other 5xx as provider rejection", () => {
    expect(classifySendError(smtpError({ code: "EENVELOPE", responseCode: 550 }))).toMatchObject({
      kind: "permanent",
      failureCode: "invalid_recipient",
    });
    expect(classifySendError(smtpError({ code: "EMESSAGE", responseCode: 554 }))).toMatchObject({
      kind: "permanent",
      failureCode: "provider_rejected",
    });
  });

  it("never retries an ambiguous failure during or after DATA", () => {
    for (const fields of [
      { code: "ETIMEDOUT", command: "DATA" },
      { code: "ESOCKET" },
      { code: "ECONNRESET", command: "message" },
      {},
    ]) {
      expect(classifySendError(smtpError(fields))).toMatchObject({
        kind: "permanent",
        failureCode: "unknown_outcome",
      });
    }
  });

  it("never exposes the raw provider message", () => {
    const outcome = classifySendError(smtpError({ code: "EENVELOPE", responseCode: 550 }));
    expect(JSON.stringify(outcome)).not.toContain("alici@ornek.com");
  });
});

describe("retryDelayMs", () => {
  it("backs off and caps at an hour", () => {
    expect(retryDelayMs(1)).toBe(5 * 60_000);
    expect(retryDelayMs(2)).toBe(10 * 60_000);
    expect(retryDelayMs(10)).toBe(60 * 60_000);
  });
});
