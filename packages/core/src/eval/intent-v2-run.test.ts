import { describe, expect, it } from "vitest";
import type { LlmCallOptions, LlmClient, LlmJsonRequest } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import type { IntentV2Case } from "./intent-v2-eval.ts";
import { RUN_MAX_OUTPUT_TOKENS, runIntentV2Predictions } from "./intent-v2-run.ts";

const at = new Date("2026-11-04T00:00:00Z");

function cases(n: number): IntentV2Case[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    cat: "x",
    lang: "tr",
    typo: false,
    q: `sorgu ${i}`,
    gold: {} as IntentV2Case["gold"],
  }));
}

function fakeClient(
  behave: (req: LlmJsonRequest, opts: LlmCallOptions) => Promise<unknown>,
): LlmClient & { requests: LlmJsonRequest[] } {
  const requests: LlmJsonRequest[] = [];
  return {
    modelVersion: "gemini-3.1-flash-lite",
    requests,
    async generateJson(req, opts = {}) {
      requests.push(req);
      const value = await behave(req, opts);
      return {
        value,
        usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
        modelVersion: "gemini-3.1-flash-lite",
      };
    },
  };
}

const usage = { inputTokens: 1000, outputTokens: 100, thoughtTokens: 0, totalTokens: 1100 };

describe("runIntentV2Predictions", () => {
  it("her vaka icin tek istek; ham cikti id ile doner; maliyet ve gecikme raporlanir", async () => {
    const client = fakeClient(async (_req, { onCall }) => {
      onCall?.({ modelVersion: "gemini-3.1-flash-lite", httpStatus: 200, usage });
      return { schema_version: 2 };
    });
    let t = 0;
    const { predictions, report } = await runIntentV2Predictions(
      cases(3),
      client,
      { maxCalls: 100, maxUsdMicros: 1_000_000, attemptsPerCase: 2 },
      { at, now: () => (t += 10) },
    );
    expect(client.requests).toHaveLength(3);
    expect(client.requests[0]?.maxOutputTokens).toBe(RUN_MAX_OUTPUT_TOKENS);
    expect(Object.keys(predictions)).toEqual(["c0", "c1", "c2"]);
    expect(report.ok).toBe(3);
    expect(report.httpAttempts).toBe(3);
    // 1000 x 0.25 + 100 x 1.5 = 400 USD-mikro / vaka
    expect(report.usdMicros).toBe(1200);
    expect(report.usdMicrosPer1000).toBe(400_000);
    expect(report.latencyP95Ms).toBe(10);
  });

  it("cagri tavani: en kotu durum (tum denemeler) tavani asacaksa vaka baslamaz", async () => {
    const client = fakeClient(async (_req, { onCall }) => {
      onCall?.({ modelVersion: "gemini-3.1-flash-lite", httpStatus: 200, usage });
      return {};
    });
    const { report } = await runIntentV2Predictions(
      cases(5),
      client,
      { maxCalls: 5, maxUsdMicros: 1_000_000, attemptsPerCase: 2 },
      { at },
    );
    // 2+2 tamam; 3. vaka icin 3+2 > 5 degil (=5) -> baslar; 4. icin 3+2>5 -> atlar
    expect(client.requests.length).toBeLessThanOrEqual(5);
    expect(report.httpAttempts).toBeLessThanOrEqual(5);
    expect(report.skippedBudget).toBe(5 - client.requests.length);
  });

  it("maliyet tavani asilmaz; kullanimi okunamayan deneme en kotu durumla sayilir", async () => {
    const client = fakeClient(async (_req, { onCall }) => {
      onCall?.({ modelVersion: "gemini-3.1-flash-lite", httpStatus: null, usage: null });
      throw new LlmError("timeout");
    });
    const { report } = await runIntentV2Predictions(
      cases(50),
      client,
      { maxCalls: 1000, maxUsdMicros: 5_000, attemptsPerCase: 1 },
      { at },
    );
    expect(report.usdMicros).toBeLessThanOrEqual(5_000);
    expect(report.errors.timeout).toBeGreaterThan(0);
    expect(report.skippedBudget).toBeGreaterThan(0);
    expect(report.ok).toBe(0);
  });

  it("gecersiz tavan ya da fiyatsiz model reddedilir (istek yok)", async () => {
    const client = fakeClient(async () => ({}));
    await expect(
      runIntentV2Predictions(
        cases(1),
        client,
        { maxCalls: 0, maxUsdMicros: 1, attemptsPerCase: 1 },
        { at },
      ),
    ).rejects.toThrow();
    const unknown = { ...fakeClient(async () => ({})), modelVersion: "bilinmeyen" };
    await expect(
      runIntentV2Predictions(
        cases(1),
        unknown,
        { maxCalls: 9, maxUsdMicros: 9, attemptsPerCase: 1 },
        { at },
      ),
    ).rejects.toThrow("fiyat");
    expect(client.requests).toHaveLength(0);
  });
});
