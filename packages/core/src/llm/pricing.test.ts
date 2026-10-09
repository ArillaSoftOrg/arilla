import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmCall } from "./client.ts";
import { GEMINI_MODEL } from "./model.ts";
import {
  estimateLlmCallCost,
  findLlmPriceRule,
  LLM_COST_FX_ENV,
  LLM_PRICE_RULES,
  type LlmPriceRule,
  llmUsageColumns,
  parseFxMicros,
} from "./pricing.ts";

const AT = new Date("2026-10-08T12:00:00Z");
const ENV = { [LLM_COST_FX_ENV]: "41.25" };

function call(usage: LlmCall["usage"], modelVersion = GEMINI_MODEL): LlmCall {
  return { modelVersion, httpStatus: 200, usage };
}

const usage = (inputTokens: number, outputTokens: number, thoughtTokens = 0) => ({
  inputTokens,
  outputTokens,
  thoughtTokens,
  totalTokens: inputTokens + outputTokens + thoughtTokens,
});

describe("fiyat kurallari", () => {
  it("kodda kullanilan model icin yururlukte bir kural var", () => {
    const rule = findLlmPriceRule(GEMINI_MODEL, AT);
    expect(rule?.id).toBe("gemini-3.1-flash-lite@2026-10-07");
    // Resmi sayfa (2026-10-07): $0.25 / 1M girdi, $1.50 / 1M cikti (dusunme dahil).
    expect(rule?.inputUsdMicrosPerMTok).toBe(250_000);
    expect(rule?.outputUsdMicrosPerMTok).toBe(1_500_000);
  });

  it("kimlikler essiz, ayni modelin donemleri cakismaz", () => {
    expect(new Set(LLM_PRICE_RULES.map((r) => r.id)).size).toBe(LLM_PRICE_RULES.length);
    const byModel = new Map<string, LlmPriceRule[]>();
    for (const rule of LLM_PRICE_RULES) {
      byModel.set(rule.model, [...(byModel.get(rule.model) ?? []), rule]);
    }
    for (const rules of byModel.values()) {
      const sorted = [...rules].sort(
        (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
      );
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1] as LlmPriceRule;
        const next = sorted[i] as LlmPriceRule;
        expect(prev.effectiveUntil).not.toBeNull();
        expect(prev.effectiveUntil?.getTime()).toBeLessThanOrEqual(next.effectiveFrom.getTime());
      }
    }
  });

  it("donem disi tarih kural bulmaz (gecmise uygulanmaz)", () => {
    expect(findLlmPriceRule(GEMINI_MODEL, new Date("2026-10-06T23:59:59Z"))).toBeNull();
  });

  it("surum gecisi: eski kural bitiste haric, yeni kural baslangicta dahil", () => {
    const boundary = new Date("2027-01-01T00:00:00Z");
    const rules: LlmPriceRule[] = [
      { ...(LLM_PRICE_RULES[0] as LlmPriceRule), id: "eski", effectiveUntil: boundary },
      {
        ...(LLM_PRICE_RULES[0] as LlmPriceRule),
        id: "yeni",
        effectiveFrom: boundary,
        inputUsdMicrosPerMTok: 500_000,
      },
    ];
    expect(findLlmPriceRule(GEMINI_MODEL, new Date(boundary.getTime() - 1), rules)?.id).toBe(
      "eski",
    );
    expect(findLlmPriceRule(GEMINI_MODEL, boundary, rules)?.id).toBe("yeni");
  });
});

describe("kur", () => {
  it.each([
    ["41.25", 41_250_000],
    [" 41 ", 41_000_000],
    ["0.000001", 1],
    ["41.123456", 41_123_456],
  ])("%s gecerli", (raw, micros) => {
    expect(parseFxMicros(raw)).toBe(micros);
  });

  it.each([undefined, "", "0", "0.0", "-41", "41,25", "4.1e1", "abc", "41.1234567", "1234567"])(
    "%s gecersiz -> null (0 uydurulmaz)",
    (raw) => {
      expect(parseFxMicros(raw)).toBeNull();
    },
  );
});

describe("cagri maliyeti", () => {
  it("girdi + (cikti + dusunme) ayri fiyatlarla, kurla, yukari yuvarlanir", () => {
    // (100 x 250_000 + 60 x 1_500_000) x 41_250_000 / 10^12 = 4743,75 -> 4744
    expect(estimateLlmCallCost(call(usage(100, 50, 10)), { at: AT, env: ENV })).toEqual({
      kind: "estimated",
      costMicros: 4744,
      ruleId: "gemini-3.1-flash-lite@2026-10-07",
    });
  });

  it("1M girdi ve 1M cikti token resmi fiyatla birebir", () => {
    const env = { [LLM_COST_FX_ENV]: "40" };
    const input = estimateLlmCallCost(call(usage(1_000_000, 0)), { at: AT, env });
    const output = estimateLlmCallCost(call(usage(0, 1_000_000)), { at: AT, env });
    expect(input).toMatchObject({ kind: "estimated", costMicros: 10_000_000 }); // 0,25 $ x 40
    expect(output).toMatchObject({ kind: "estimated", costMicros: 60_000_000 }); // 1,50 $ x 40
  });

  it("dusunme token'i cikti fiyatiyla ucretlenir", () => {
    const visible = estimateLlmCallCost(call(usage(0, 1000, 0)), { at: AT, env: ENV });
    const thought = estimateLlmCallCost(call(usage(0, 0, 1000)), { at: AT, env: ENV });
    expect(thought).toEqual(visible);
  });

  it("tek token bile 0 olmaz: fiyatlanmis cagri fiyatlanmamisla karismaz", () => {
    expect(estimateLlmCallCost(call(usage(1, 0)), { at: AT, env: ENV })).toMatchObject({
      kind: "estimated",
      costMicros: 11,
    });
  });

  it("bilinmeyen model 0 sayilmaz", () => {
    expect(
      estimateLlmCallCost(call(usage(10, 10), "gemini-9-ultra"), { at: AT, env: ENV }),
    ).toEqual({ kind: "unpriced", reason: "unknown_model" });
  });

  it("kullanim yok (zaman asimi, ag) ya da okunamadi -> fiyatlanmamis", () => {
    expect(estimateLlmCallCost(call(null), { at: AT, env: ENV })).toEqual({
      kind: "unpriced",
      reason: "missing_usage",
    });
    expect(estimateLlmCallCost(call(usage(0, 0)), { at: AT, env: ENV })).toEqual({
      kind: "unpriced",
      reason: "missing_usage",
    });
  });

  it("kur tanimsiz ya da gecersiz -> fiyatlanmamis", () => {
    for (const env of [{}, { [LLM_COST_FX_ENV]: "" }, { [LLM_COST_FX_ENV]: "kur" }]) {
      expect(estimateLlmCallCost(call(usage(10, 10)), { at: AT, env })).toEqual({
        kind: "unpriced",
        reason: "missing_fx_rate",
      });
    }
  });

  it("buyuk sayilarda tam: 2M girdi + 500K cikti, kesirli kur", () => {
    // (2e6 x 250_000 + 5e5 x 1_500_000) = 1.25e12; x 41_123_456 / 1e12 = 51_404_320
    const env = { [LLM_COST_FX_ENV]: "41.123456" };
    expect(estimateLlmCallCost(call(usage(2_000_000, 500_000)), { at: AT, env })).toMatchObject({
      costMicros: 51_404_320,
    });
  });
});

describe("api_usage token ayrimi (0059)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("girdi, faturalanan cikti (dusunme dahil), toplam ve maliyet ayni kaynaktan", () => {
    vi.stubEnv(LLM_COST_FX_ENV, "41.25");
    expect(llmUsageColumns(call(usage(100, 50, 10)), AT)).toEqual({
      units: 160,
      inputTokens: 100,
      outputTokens: 60,
      costMicros: 4744,
    });
  });

  it("units saglayicinin toplamidir, yeniden hesaplanmaz", () => {
    vi.stubEnv(LLM_COST_FX_ENV, "41.25");
    const reported = { inputTokens: 100, outputTokens: 50, thoughtTokens: 10, totalTokens: 999 };
    expect(llmUsageColumns(call(reported), AT)).toMatchObject({ units: 999, outputTokens: 60 });
  });

  it("kullanim bildirilmedi (zaman asimi, ag): units 0, tokenler NULL, maliyet 0", () => {
    vi.stubEnv(LLM_COST_FX_ENV, "41.25");
    expect(llmUsageColumns(call(null), AT)).toEqual({
      units: 0,
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
    });
  });

  it("okunamayan (hepsi 0) kullanim tokenleri NULL yazar, 0 uydurmaz", () => {
    vi.stubEnv(LLM_COST_FX_ENV, "41.25");
    expect(llmUsageColumns(call(usage(0, 0)), AT)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
    });
  });

  it("kur tanimsiz ya da model kuralsiz: tokenler yine yazilir, maliyet 0 (fiyatlanmamis)", () => {
    vi.stubEnv(LLM_COST_FX_ENV, "");
    expect(llmUsageColumns(call(usage(100, 50, 10)), AT)).toEqual({
      units: 160,
      inputTokens: 100,
      outputTokens: 60,
      costMicros: 0,
    });
    vi.stubEnv(LLM_COST_FX_ENV, "41.25");
    expect(llmUsageColumns(call(usage(100, 50), "baska-model"), AT)).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 0,
    });
  });

  it("muhasebe hatasi istegi bozmaz: firlatmaz, satir fiyatlanmamis yazilir", () => {
    vi.stubEnv(LLM_COST_FX_ENV, "41.25");
    // Tamsayi olmayan token BigInt'i bozar; sonuc yine guvenli.
    const broken = { inputTokens: 1.5, outputTokens: 2, thoughtTokens: 0, totalTokens: 4 };
    expect(llmUsageColumns(call(broken), AT)).toEqual({
      units: 4,
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
    });
  });
});
