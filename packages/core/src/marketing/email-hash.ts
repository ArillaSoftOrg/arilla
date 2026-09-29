import { createHash } from "node:crypto";

/**
 * Bastırma ve gönderim kaydı adresi düz metin tutmaz. Normalizasyon yalnızca
 * boşluk kırpma + ASCII küçük harf: `toLocaleLowerCase("tr-TR")` KULLANILMAZ
 * (İ/ı dönüşümü aynı adres için farklı özet üretirdi).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email), "utf8").digest("hex");
}

/** Tek `@`, boş olmayan yerel kısım, noktalı alan adı, boşluk/kontrol karakteri yok. */
export function isDeliverableEmailShape(email: string): boolean {
  const value = normalizeEmail(email);
  if (value.length > 254) return false;
  return /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(value);
}
