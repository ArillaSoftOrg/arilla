/**
 * Metin modeli cagrilarinin TAHMINI maliyeti (docs/decisions/0082).
 *
 * `api_usage.cost_micros` saglayicinin faturasi DEGILDIR: resmi liste fiyati
 * (surumlu kural) x cagrinin token sayilari x yoneticinin tanimladigi kur.
 * Gercek faturalanan tutar yalnizca saglayicinin faturalama dokumunden
 * okunabilir (dis entegrasyon, bu kararin disinda).
 *
 * Bilinmeyen hicbir sey 0 maliyet sayilmaz:
 * - Kural yok (bilinmeyen model ya da kural donemi disi) -> `unpriced`.
 * - Kullanim yok (zaman asimi, ag hatasi, kullanimsiz yanit) -> `unpriced`.
 * - Kur tanimsiz ya da gecersiz -> `unpriced`.
 * `unpriced` cagri `cost_micros = 0` ile yazilir ve yonetim bunu
 * "fiyatlanmamis" diye ayrica sayar (`admin/cost-truth.ts`, karar 0051);
 * tutar "Hesaplanmadi" ya da "en az ..." olarak gosterilir.
 *
 * Gecmis satirlar degistirilmez: kural yalnizca yeni yazilan satira uygulanir.
 */
import type { LlmCall } from "./client.ts";

export interface LlmPriceRule {
  /** Kalici kimlik: `<model>@<yururluk tarihi>`. Degistirilmez, yeni surum eklenir. */
  id: string;
  model: string;
  /** Saglayici fiyat katmani; ucretli anahtar standart katmandir (.env.example, 0059 m.8). */
  tier: "standard";
  /** Dahil (UTC). */
  effectiveFrom: Date;
  /** Haric (UTC); `null` = yururlukte. */
  effectiveUntil: Date | null;
  /** 1 milyon girdi token'i icin USD'nin milyonda biri (metin/gorsel/video). */
  inputUsdMicrosPerMTok: number;
  /** 1 milyon cikti token'i icin USD'nin milyonda biri; dusunme token'lari dahil. */
  outputUsdMicrosPerMTok: number;
  /** Resmi fiyat sayfasi ve dogrulandigi gun. */
  source: string;
  verifiedOn: string;
}

/**
 * Surumlu fiyat kurallari. Fiyat degisince eski kuralin `effectiveUntil`'i
 * doldurulur ve yeni kimlikle yeni kural eklenir; donemler cakisamaz (test).
 */
export const LLM_PRICE_RULES: readonly LlmPriceRule[] = [
  {
    id: "gemini-3.1-flash-lite@2026-10-07",
    model: "gemini-3.1-flash-lite",
    tier: "standard",
    effectiveFrom: new Date("2026-10-07T00:00:00Z"),
    effectiveUntil: null,
    // $0.25 / 1M girdi (metin/gorsel/video), $1.50 / 1M cikti (dusunme dahil).
    inputUsdMicrosPerMTok: 250_000,
    outputUsdMicrosPerMTok: 1_500_000,
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    verifiedOn: "2026-10-08",
  },
  {
    // Internet urun aramasi (karar 0102). Arac (URL Context) ile okunan sayfa
    // icerigi girdi token'i olarak ayni fiyattan ucretlenir; arama grounding
    // ucreti token'dan AYRIDIR (`GROUNDING_PRICE_RULES`).
    id: "gemini-3.5-flash-lite@2026-10-11",
    model: "gemini-3.5-flash-lite",
    tier: "standard",
    effectiveFrom: new Date("2026-10-11T00:00:00Z"),
    effectiveUntil: null,
    // $0.30 / 1M girdi (metin/gorsel/video/ses), $2.50 / 1M cikti (dusunme dahil).
    inputUsdMicrosPerMTok: 300_000,
    outputUsdMicrosPerMTok: 2_500_000,
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    verifiedOn: "2026-10-11",
  },
];

/**
 * Google Search grounding ucreti: Gemini 3+ modellerinde modelin YURUTTUGU her
 * arama sorgusu icin (bir istekte birden cok olabilir). Token ucretinden
 * ayrildir ve ayri `api_usage` satirinda (`units` = sorgu sayisi) izlenir.
 */
export interface GroundingPriceRule {
  /** Kalici kimlik; degistirilmez, yeni surum eklenir. */
  id: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  /** Bir arama sorgusu icin USD'nin milyonda biri (14 USD / 1000 = 14.000). */
  usdMicrosPerQuery: number;
  /**
   * Aylik ucretsiz kontenjan (tum Gemini 3+ modelleri ve projeler arasi
   * ORTAK). Satir bazli maliyet BU KONTENJANI DIKKATE ALMAZ: liste fiyatidir,
   * yani ust sinirdir; gercek fatura daha dusuk olabilir.
   */
  freeMonthlyQueries: number;
  source: string;
  verifiedOn: string;
}

export const GROUNDING_PRICE_RULES: readonly GroundingPriceRule[] = [
  {
    id: "google-search-grounding@2026-10-11",
    effectiveFrom: new Date("2026-10-11T00:00:00Z"),
    effectiveUntil: null,
    usdMicrosPerQuery: 14_000,
    freeMonthlyQueries: 5_000,
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    verifiedOn: "2026-10-11",
  },
];

export type GroundingCostEstimate =
  | { kind: "estimated"; costMicros: number; ruleId: string }
  | { kind: "unpriced"; reason: "no_queries" | "unknown_rule" | "missing_fx_rate" };

/** Sorgu sayisi x liste fiyati x kur; yukari yuvarlanir (BigInt). */
export function estimateGroundingCost(
  queries: number,
  options: {
    at: Date;
    env?: Readonly<Record<string, string | undefined>>;
    rules?: readonly GroundingPriceRule[];
  },
): GroundingCostEstimate {
  if (!Number.isInteger(queries) || queries <= 0) return { kind: "unpriced", reason: "no_queries" };
  const time = options.at.getTime();
  const rule = (options.rules ?? GROUNDING_PRICE_RULES).find(
    (r) =>
      time >= r.effectiveFrom.getTime() &&
      (r.effectiveUntil === null || time < r.effectiveUntil.getTime()),
  );
  if (!rule) return { kind: "unpriced", reason: "unknown_rule" };
  const fx = parseFxMicros((options.env ?? process.env)[LLM_COST_FX_ENV]);
  if (fx === null) return { kind: "unpriced", reason: "missing_fx_rate" };
  const numerator = BigInt(queries) * BigInt(rule.usdMicrosPerQuery) * BigInt(fx);
  const denominator = 1_000_000n;
  return {
    kind: "estimated",
    costMicros: Number((numerator + denominator - 1n) / denominator),
    ruleId: rule.id,
  };
}

/** `api_usage.cost_micros` icin: tahmin varsa o, yoksa 0 ("fiyatlanmamis"). */
export function groundingCostMicros(queries: number, at: Date = new Date()): number {
  const estimate = estimateGroundingCost(queries, { at });
  return estimate.kind === "estimated" ? estimate.costMicros : 0;
}

/** Kur: 1 USD kac TRY. Ondalik nokta, en cok 6 basamak; or. `41.25`. */
export const LLM_COST_FX_ENV = "LLM_COST_TRY_PER_USD";

export type LlmUnpricedReason = "unknown_model" | "missing_usage" | "missing_fx_rate";

export type LlmCostEstimate =
  | { kind: "estimated"; costMicros: number; ruleId: string }
  | { kind: "unpriced"; reason: LlmUnpricedReason };

export function findLlmPriceRule(
  model: string,
  at: Date,
  rules: readonly LlmPriceRule[] = LLM_PRICE_RULES,
): LlmPriceRule | null {
  const time = at.getTime();
  return (
    rules.find(
      (rule) =>
        rule.model === model &&
        time >= rule.effectiveFrom.getTime() &&
        (rule.effectiveUntil === null || time < rule.effectiveUntil.getTime()),
    ) ?? null
  );
}

const FX_PATTERN = /^([0-9]{1,6})(?:\.([0-9]{1,6}))?$/;

/**
 * Kuru TRY'nin milyonda biri cinsinden tamsayiya cevirir (ondalik hata yok).
 * Bos, gecersiz ya da sifir kur `null`: tahmin yapilmaz, 0 uydurulmaz.
 */
export function parseFxMicros(raw: string | undefined): number | null {
  const match = FX_PATTERN.exec(raw?.trim() ?? "");
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  const micros = whole * 1_000_000 + fraction;
  return micros > 0 ? micros : null;
}

/** Faturalanan token'lar: girdi + cikti + dusunme (dusunme cikti fiyatiyla). */
function billableTokens(call: LlmCall): { input: number; output: number } | null {
  const usage = call.usage;
  if (usage === null) return null;
  const output = usage.outputTokens + usage.thoughtTokens;
  // Hepsi 0 olan kullanim "okunamadi" demektir (ayristirici eksik alani 0 yapar).
  if (usage.inputTokens + output === 0) return null;
  return { input: usage.inputTokens, output };
}

const MICROS_PER_UNIT = 1_000_000n;

/**
 * Tek bir HTTP denemesinin tahmini maliyeti, TRY'nin milyonda biri.
 * Yukari yuvarlanir: fiyatlanmis cagri asla 0 gorunmez (0 = fiyatlanmamis).
 * Ara hesap BigInt: (token x USD-mikro/1M x TRY-mikro/USD) / 10^12.
 */
export function estimateLlmCallCost(
  call: LlmCall,
  options: {
    at: Date;
    env?: Readonly<Record<string, string | undefined>>;
    rules?: readonly LlmPriceRule[];
  },
): LlmCostEstimate {
  const rule = findLlmPriceRule(call.modelVersion, options.at, options.rules);
  if (!rule) return { kind: "unpriced", reason: "unknown_model" };
  const tokens = billableTokens(call);
  if (!tokens) return { kind: "unpriced", reason: "missing_usage" };
  const fx = parseFxMicros((options.env ?? process.env)[LLM_COST_FX_ENV]);
  if (fx === null) return { kind: "unpriced", reason: "missing_fx_rate" };

  const usdTimesMillion =
    BigInt(tokens.input) * BigInt(rule.inputUsdMicrosPerMTok) +
    BigInt(tokens.output) * BigInt(rule.outputUsdMicrosPerMTok);
  const numerator = usdTimesMillion * BigInt(fx);
  const denominator = MICROS_PER_UNIT * MICROS_PER_UNIT;
  const costMicros = Number((numerator + denominator - 1n) / denominator);
  return { kind: "estimated", costMicros, ruleId: rule.id };
}

const reportedReasons = new Set<LlmUnpricedReason>();

/**
 * `api_usage.cost_micros` icin deger: tahmin varsa o, yoksa 0 (yonetim
 * "fiyatlanmamis" sayar). Neden surec basina bir kez loglanir; deger, model
 * ciktisi ya da kullanici bilgisi loglanmaz. Eksik kullanim (basarisiz deneme)
 * olagan oldugu icin loglanmaz.
 */
export function llmCallCostMicros(call: LlmCall, at: Date = new Date()): number {
  const estimate = estimateLlmCallCost(call, { at });
  if (estimate.kind === "estimated") return estimate.costMicros;
  if (estimate.reason !== "missing_usage" && !reportedReasons.has(estimate.reason)) {
    reportedReasons.add(estimate.reason);
    console.warn(
      `[llm] maliyet tahmini yapilamadi: ${estimate.reason}; cost_micros=0 (fiyatlanmamis)`,
    );
  }
  return 0;
}
