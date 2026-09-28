/**
 * Giris akislarinin (Google, Apple, telefon) ortak guvenli hata kategorisi
 * yardimcilari. Kategori loga yazilir; token, code, secret, e-posta, telefon
 * ya da hata MESAJI icermez - yalnizca adim adi, SQLSTATE ve tablo adi.
 */

/** Postgres hatasi (dogrudan ya da Drizzle `cause` zincirinde): `db:42P01:user_identity`. */
export function databaseFailureCategory(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const message = String((current as { message?: unknown }).message ?? "");
      const relation = /relation "([a-z_][a-z0-9_]*)" does not exist/.exec(message)?.[1];
      return relation ? `db:${code}:${relation}` : `db:${code}`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Bilinmeyen hata: yalnizca sinif adi (`unexpected:TypeError`), mesaj asla. */
export function unexpectedFailureCategory(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "unknown";
  return `unexpected:${name}`;
}

/** Saglayicinin dondurdugu hata kodu (`invalid_client`, `30`) guvenli ise, degilse "unknown". */
export function safeProviderCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,40}$/i.test(value) ? value : "unknown";
}
