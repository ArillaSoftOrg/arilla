import { describe, expect, it } from "vitest";
import type { LlmCall } from "./client.ts";
import { GEMINI_MODEL } from "./model.ts";
import { llmCostMicros, llmUsageRecord, MODEL_PRICING, usdTryRate } from "./pricing.ts";

const RATE = { USD_TRY_RATE: "40" };

function call(usage: LlmCall["usage"], modelVersion = GEMINI_MODEL): LlmCall {
  return { modelVersion, httpStatus: usage ? 200 : null, usage };
}

describe("fiyat tablosu", () => {
  it("gemini-3.1-flash-lite: girdi 0,25 USD / cikti 1,50 USD (1M token)", () => {
    expect(MODEL_PRICING[GEMINI_MODEL]).toEqual({
      inputUsdMicrosPerMillion: 250_000,
      outputUsdMicrosPerMillion: 1_500_000,
    });
  });
});

describe("llmCostMicros", () => {
  it("girdi ve cikti ayri fiyatlanir, sonuc TRY milyonda biri", () => {
    // 1M girdi = 0,25 USD; 1M cikti = 1,50 USD; kur 40 -> 10 TRY + 60 TRY.
    expect(llmCostMicros(GEMINI_MODEL, 1_000_000, 0, RATE)).toBe(10_000_000);
    expect(llmCostMicros(GEMINI_MODEL, 0, 1_000_000, RATE)).toBe(60_000_000);
    // 1000 girdi + 250 cikti: (250 + 375) USD-mikro * 40 = 25 000 TRY-mikro.
    expect(llmCostMicros(GEMINI_MODEL, 1000, 250, RATE)).toBe(25_000);
  });

  it("kur yok/gecersiz ya da model fiyatsiz: 0 (fiyatlanmamis)", () => {
    expect(llmCostMicros(GEMINI_MODEL, 1000, 250, {})).toBe(0);
    expect(llmCostMicros(GEMINI_MODEL, 1000, 250, { USD_TRY_RATE: "abc" })).toBe(0);
    expect(llmCostMicros(GEMINI_MODEL, 1000, 250, { USD_TRY_RATE: "-3" })).toBe(0);
    expect(llmCostMicros("bilinmeyen-model", 1000, 250, RATE)).toBe(0);
  });
});

describe("usdTryRate", () => {
  it("pozitif ondalik kabul eder, makul siniri asani reddeder", () => {
    expect(usdTryRate({ USD_TRY_RATE: "41.25" })).toBe(41.25);
    expect(usdTryRate({ USD_TRY_RATE: " 40 " })).toBe(40);
    expect(usdTryRate({})).toBeNull();
    expect(usdTryRate({ USD_TRY_RATE: "0" })).toBeNull();
    expect(usdTryRate({ USD_TRY_RATE: "4125000" })).toBeNull();
    expect(usdTryRate({ USD_TRY_RATE: "1e3" })).toBeNull();
  });
});

describe("llmUsageRecord", () => {
  it("saglayicinin bildirdigi ayrimi kullanir; dusunme cikti fiyatiyla sayilir", () => {
    const record = llmUsageRecord(
      call({ inputTokens: 1000, outputTokens: 200, thoughtTokens: 50, totalTokens: 1250 }),
      RATE,
    );
    expect(record).toEqual({
      units: 1250,
      inputTokens: 1000,
      outputTokens: 250,
      costMicros: 25_000,
    });
  });

  it("kullanim bildirilmediyse (hata/zaman asimi) tokenler NULL, maliyet 0: uydurulmaz", () => {
    expect(llmUsageRecord(call(null), RATE)).toEqual({
      units: 0,
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
    });
  });

  it("kur yokken token ayrimi yine yazilir (sonradan fiyatlanabilir)", () => {
    expect(
      llmUsageRecord(
        call({ inputTokens: 90, outputTokens: 10, thoughtTokens: 0, totalTokens: 100 }),
        {},
      ),
    ).toEqual({ units: 100, inputTokens: 90, outputTokens: 10, costMicros: 0 });
  });

  it("bozuk sayilar sifira ceker, asla firlatmaz", () => {
    const record = llmUsageRecord(
      call({
        inputTokens: Number.NaN,
        outputTokens: -5,
        thoughtTokens: 3.7,
        totalTokens: Infinity,
      }),
      RATE,
    );
    expect(record).toEqual({ units: 0, inputTokens: 0, outputTokens: 3, costMicros: 180 });
  });
});
