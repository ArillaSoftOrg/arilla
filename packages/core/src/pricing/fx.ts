/**
 * Yaklasik TRY gosterimi (karar 0113).
 *
 * Kurallar:
 * - Orijinal tutar ve para birimi DEGISMEZ; donusum yalnizca gosterim icindir
 *   ve her zaman "yaklasik" olarak, kaynak (TCMB) ve kur tarihiyle sunulur.
 * - Kur yoksa ya da `MAX_RATE_AGE_DAYS`'ten eskiyse donusum YAPILMAZ (null);
 *   kur uydurulmaz, sabit kur kullanilmaz.
 * - Hesap tamsayi/BigInt ile yapilir: float yok (fiyatlar kurus/cent tamsayi).
 */
import { type Database, fxRate } from "@arilla/db";
import { and, desc, eq } from "drizzle-orm";

/** TCMB hafta sonu ve resmi tatilde bulten yayimlamaz; 4 gun uzun tatili kapsar. */
export const MAX_RATE_AGE_DAYS = 4;
const RATE_SCALE = 100_000_000n;

export interface FxQuote {
  source: "tcmb";
  base: string;
  /** 1 birim base = `rate` TRY; ondalik metin (NUMERIC(20,8)). */
  rate: string;
  rateKind: "forex_selling" | "forex_buying";
  /** Bulten tarihi, YYYY-MM-DD. */
  effectiveDate: string;
  bulletin: string | null;
}

export interface ApproxTry {
  /** Yaklasik TRY, kurus. */
  approxTryMinor: number;
  /** Kaynak tutar ve para birimi (degismez). */
  originalMinor: number;
  currency: string;
  quote: FxQuote;
}

function scaledRate(rate: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(rate.trim());
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  const value = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(8, "0"));
  return value > 0n ? value : null;
}

function ageDays(effectiveDate: string, now: Date): number | null {
  const parsed = Date.parse(`${effectiveDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - parsed) / 86_400_000);
}

/** Kaynak tutari yaklasik TRY'ye cevirir; kur yok/eski/gecersizse null. */
export function approximateTry(
  amountMinor: number,
  currency: string,
  quote: FxQuote | null,
  now: Date = new Date(),
): ApproxTry | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  if (!quote || quote.base !== currency || currency === "TRY") return null;
  const age = ageDays(quote.effectiveDate, now);
  if (age === null || age < 0 || age > MAX_RATE_AGE_DAYS) return null;
  const rate = scaledRate(quote.rate);
  if (rate === null) return null;
  // amount(cent) * rate / 1e8 -> kurus; yarim yukari yuvarlama.
  const product = BigInt(amountMinor) * rate;
  const approx = (product + RATE_SCALE / 2n) / RATE_SCALE;
  if (approx > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { approxTryMinor: Number(approx), originalMinor: amountMinor, currency, quote };
}

/** En guncel TCMB doviz satis kuru (yoksa null). */
export async function latestFxQuote(db: Database, base: string): Promise<FxQuote | null> {
  const rows = await db
    .select({
      base: fxRate.base,
      rate: fxRate.rate,
      rateKind: fxRate.rateKind,
      effectiveDate: fxRate.effectiveDate,
      bulletin: fxRate.bulletin,
    })
    .from(fxRate)
    .where(
      and(
        eq(fxRate.source, "tcmb"),
        eq(fxRate.base, base),
        eq(fxRate.quote, "TRY"),
        eq(fxRate.rateKind, "forex_selling"),
      ),
    )
    .orderBy(desc(fxRate.effectiveDate))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    source: "tcmb",
    base: row.base,
    rate: String(row.rate),
    rateKind: row.rateKind,
    effectiveDate: String(row.effectiveDate),
    bulletin: row.bulletin,
  };
}
