/**
 * Sorgu normalizasyonu bayragi (karar 0172). Ortamdan yalnizca sunucuda okunur.
 *
 * - `off` (varsayilan, bilinmeyen her deger): normalizasyon cagrilmaz; arama bugunku gibi.
 * - `shadow`: hesaplanir, aramaya uygulanmaz; yalniz sorgu metni icermeyen sayaclar.
 * - `on`: duzeltmeler arama slotlarina alternatif olarak eklenir (Faz 2).
 */
export type QueryNormalizationMode = "off" | "shadow" | "on";

type Env = Readonly<Record<string, string | undefined>>;

export function queryNormalizationMode(env: Env = process.env): QueryNormalizationMode {
  const value = env.QUERY_NORMALIZATION_MODE?.trim().toLowerCase();
  return value === "shadow" || value === "on" ? value : "off";
}
