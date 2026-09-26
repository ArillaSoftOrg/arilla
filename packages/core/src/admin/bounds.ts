/**
 * `/yonetim` sorgularının ortak sınırları. Yönetim ekranları büyük tabloları
 * okur (teklif, fiyat, embedding); her liste sayfalı, her pahalı sorgu
 * zaman aşımlıdır ve salt okunur işlemde çalışır.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

export const ADMIN_PAGE_SIZE_DEFAULT = 50;
export const ADMIN_PAGE_SIZE_MAX = 100;

export function clampPageSize(
  value: number | undefined,
  fallback = ADMIN_PAGE_SIZE_DEFAULT,
): number {
  const n = Math.trunc(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, n), ADMIN_PAGE_SIZE_MAX);
}

/** Pozitif güvenli tamsayı mı (kimlik, imleç). */
export function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Salt okunur işlem + `statement_timeout`. Tanılama sorguları (yetim tarama,
 * sitemap uygunluğu, arama tanısı) yanlışlıkla pahalı olursa istek yolunu ve
 * veritabanını kilitlemez; `READ ONLY` da yanlışlıkla yazmayı motor
 * düzeyinde reddeder (ör. önbellek yazan bir fonksiyon araya girerse).
 */
export async function readOnly<T>(
  db: Database,
  timeoutMs: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const ms = Math.min(Math.max(100, Math.trunc(timeoutMs)), 30_000);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${ms}`));
    return fn(tx);
  });
}

/**
 * `ILIKE` için arama terimi: `%`, `_` ve ters bölü joker değil düz karakter
 * olur (Postgres'in varsayılan kaçış karakteri ters bölüdür). Terim ayrıca
 * kırpılır ve kısaltılır.
 */
export function containsPattern(term: string, maxLength = 80): string | null {
  const trimmed = term.trim().slice(0, maxLength);
  if (!trimmed) return null;
  const backslash = String.fromCharCode(92);
  const escaped = trimmed
    .split("")
    .map((ch) => (ch === backslash || ch === "%" || ch === "_" ? backslash + ch : ch))
    .join("");
  return `%${escaped}%`;
}

/** Sayfa numarası: 1..maxPage, geçersizse 1. Ofset sayfalaması derin sayfada pahalıdır. */
export function clampPage(value: unknown, maxPage = 200): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, maxPage) : 1;
}
