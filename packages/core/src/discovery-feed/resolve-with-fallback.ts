/**
 * Genel amacli oncelik kurali: gercek liste doluysa onu kullan, bosken VE
 * fallback acikca etkinlestirilmisse fallback'e dus, ikisi de yoksa/kapaliysa
 * bos don. Veri kaynagindan bagimsizdir (herhangi bir T listesi icin calisir)
 * - Faz 3.1'de anasayfa kesif izgarasinin "gercek veri > demo > bos"
 * onceligini test edilebilir kilmak icin cikarildi (apps/web/app/
 * discovery-adapter.ts). Demo veri veya env okuma burada YOK - cagiran
 * taraf saglar.
 */
export function resolveWithFallback<T>(
  realItems: readonly T[],
  fallbackItems: readonly T[],
  fallbackEnabled: boolean,
): readonly T[] {
  if (realItems.length > 0) return realItems;
  if (fallbackEnabled) return fallbackItems;
  return [];
}
