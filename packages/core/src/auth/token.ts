/**
 * decision 0006 madde 2: token tek kullanimlik, veritabaninda hash'lenmis,
 * hicbir yerde duz metin loglanmaz. Ham token asla `console.log` veya hata
 * mesaji icine yazilmaz - cagiran kod bunu yalnizca e-posta gonderiminde ve
 * cerez degerinde kullanir.
 *
 * `session.token_hash` de ayni yardimcilari kullanir - iki tablo da "hash'ini
 * sakla, dogrulamada ayni hash'i uret ve kiyasla" desenini paylasiyor.
 */
import { createHmac, randomBytes } from "node:crypto";

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("SESSION_SECRET tanimli degil. .env.example dosyasina bakin.");
  }
  return value;
}

/** 256 bit rastgele token, URL'ye gomulebilir (base64url, dolgusuz). */
export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `SESSION_SECRET` pepper'i ile HMAC-SHA256. Duz SHA-256 degil - bkz. plan 0006. */
export function hashToken(rawToken: string): string {
  return createHmac("sha256", secret()).update(rawToken).digest("hex");
}
