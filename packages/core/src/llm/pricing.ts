/**
 * Model cagrisi maliyet muhasebesi: fiyatlarin TEK yeri ve `api_usage`
 * satirinin token/maliyet alanlari. Saf; istek yolunda hata firlatmaz.
 *
 * Kaynak: saglayicinin yanitta bildirdigi `usage` (Interactions API
 * `total_input_tokens`, `total_output_tokens`, `total_thought_tokens`,
 * `total_tokens`). Token ayrimi TAHMIN EDILMEZ.
 *
 * - `input_tokens`  = `total_input_tokens` (istem + gorsel; ayni fiyat).
 * - `output_tokens` = `total_output_tokens + total_thought_tokens`: Gemini
 *   dusunme tokenini cikti fiyatiyla ucretlendirir, bu yuzden faturalanan
 *   cikti ikisinin toplamidir.
 * - `units`         = `total_tokens` (saglayicinin toplami; eski anlam aynen).
 * - Kullanim bildirilmediyse (zaman asimi, ag hatasi, gecersiz yanit) token
 *   alanlari NULL, `units` 0, `cost_micros` 0: bilinmeyen sifir yazilmaz,
 *   uydurulmaz.
 *
 * Maliyet: `cost_micros` TRY'nin milyonda biridir (`api_usage` sozlesmesi,
 * embedding ile ayni). Model fiyati USD listesidir; kur ortamdan okunur
 * (`USD_TRY_RATE`). Kur tanimsiz/gecersizse ya da model fiyat tablosunda
 * yoksa `cost_micros` 0 kalir ve yonetimde "fiyatlanmamis" gorunur; token
 * kolonlari dolu oldugu icin sonradan yeniden fiyatlanabilir.
 */
import type { LlmCall } from "./client.ts";
import { GEMINI_MODEL } from "./model.ts";

export interface ModelPrice {
  /** 1 milyon girdi tokeni, USD milyonda biri (0,25 USD = 250_000). */
  inputUsdMicrosPerMillion: number;
  /** 1 milyon cikti (dusunme dahil) tokeni, USD milyonda biri. */
  outputUsdMicrosPerMillion: number;
}

/**
 * Model surumu -> liste fiyati (Gemini API ucretli standart katman,
 * ai.google.dev/gemini-api/docs/pricing). Fiyat degisirse yalnizca burasi
 * guncellenir; yeni model buraya eklenmeden fiyatlanmaz.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  [GEMINI_MODEL]: { inputUsdMicrosPerMillion: 250_000, outputUsdMicrosPerMillion: 1_500_000 },
};

/** Akla yatkin kur siniri: yanlis birimle (or. kurus) girilen degeri reddeder. */
const MAX_USD_TRY_RATE = 10_000;

type Env = Readonly<Record<string, string | undefined>>;

let invalidRateReported = false;

/** `USD_TRY_RATE` (or. "41.25"); tanimsiz/gecersiz -> null (fiyatlanmaz). */
export function usdTryRate(env: Env = process.env): number | null {
  const raw = env.USD_TRY_RATE?.trim() ?? "";
  if (raw === "") return null;
  const value = /^[0-9]+(\.[0-9]+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isFinite(value) && value > 0 && value <= MAX_USD_TRY_RATE) return value;
  if (!invalidRateReported) {
    invalidRateReported = true;
    // Deger loglanmaz; yalnizca gecersiz oldugu.
    console.warn("[llm-pricing] USD_TRY_RATE gecersiz (pozitif ondalik sayi olmali); maliyet 0");
  }
  return null;
}

export interface LlmUsageRecord {
  units: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** TRY milyonda bir, tamsayi. */
  costMicros: number;
}

const nonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Tek bir HTTP denemesinin `api_usage` alanlari. Asla firlatmaz. */
export function llmUsageRecord(call: LlmCall, env: Env = process.env): LlmUsageRecord {
  const usage = call.usage;
  if (!usage) return { units: 0, inputTokens: null, outputTokens: null, costMicros: 0 };
  const inputTokens = nonNegative(usage.inputTokens);
  const outputTokens = nonNegative(usage.outputTokens) + nonNegative(usage.thoughtTokens);
  const units = nonNegative(usage.totalTokens);
  return {
    units,
    inputTokens,
    outputTokens,
    costMicros: llmCostMicros(call.modelVersion, inputTokens, outputTokens, env),
  };
}

/** Girdi/cikti tokeninin TRY milyonda biri cinsinden maliyeti; fiyatlanamiyorsa 0. */
export function llmCostMicros(
  modelVersion: string,
  inputTokens: number,
  outputTokens: number,
  env: Env = process.env,
): number {
  const price = MODEL_PRICING[modelVersion];
  const rate = usdTryRate(env);
  if (!price || rate === null) return 0;
  const usdMicros =
    (inputTokens * price.inputUsdMicrosPerMillion +
      outputTokens * price.outputUsdMicrosPerMillion) /
    1_000_000;
  return Math.round(usdMicros * rate);
}
