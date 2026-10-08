/**
 * Trend semasi (migration 0056) henuz uygulanmamis bir ortamda `/trendler` 500
 * vermesin (karar 0077): yalnizca `trend` / `trend_product` iliskisi eksikse
 * (PostgreSQL 42P01) guvenli bos duruma dusulur. Baska tablonun eksikligi, baska
 * hata kodlari ve ag/yetki hatalari MASKELENMEZ, oldugu gibi firlatilir.
 *
 * Hata sessizce yutulmaz: sunucu logunda uyari (en cok dakikada bir) kalir.
 * Migration sonrasi sorgu basarili olur ve normal davranis kendiliginden surer;
 * hicbir sey onbellege alinmaz.
 */

const TREND_RELATIONS: ReadonlySet<string> = new Set(["trend", "trend_product"]);
const MISSING_RELATION = /relation "([a-z_]+)" does not exist/;
const MAX_CAUSE_DEPTH = 5;
const WARN_INTERVAL_MS = 60_000;

/** Hata zincirinde (drizzle `cause`) eksik `trend`/`trend_product` iliskisi var mi. */
export function isTrendSchemaMissing(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "42P01") {
      const relation = MISSING_RELATION.exec(current.message)?.[1];
      return relation !== undefined && TREND_RELATIONS.has(relation);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

let lastWarnAt = 0;

/** Uyariyi dakikada en cok bir kez yazar; sorgu metni, adres ya da kullanici verisi icermez. */
export function warnTrendSchemaMissing(now: number = Date.now()): void {
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn("[trendler] trend semasi yok (0056 uygulanmamis); bos liste donuluyor");
}

/** Testler icin: uyari kisitlayicisini sifirlar. */
export function resetTrendSchemaWarning(): void {
  lastWarnAt = 0;
}
