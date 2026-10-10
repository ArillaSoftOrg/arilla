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

/** Sir tanimsiz: cagiranlar bunu ayirt edip kapali kalabilsin (fail-closed). */
export class SecretNotConfiguredError extends Error {
  constructor() {
    super("SESSION_SECRET tanimli degil. .env.example dosyasina bakin.");
    this.name = "SecretNotConfiguredError";
  }
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new SecretNotConfiguredError();
  return value;
}

/** Her kullanim amaci ayri alan: ayni girdi farkli ozelliklerde farkli ozet verir. */
export type PseudonymPurpose = "auth" | "phone" | "feedback" | "forms" | "realtime";

/**
 * IP, e-posta, telefon gibi dusuk entropili degerler icin takma ad: `SESSION_SECRET`
 * ile HMAC-SHA256. Tuzsuz SHA-256 kucuk uzayda (IPv4) kaba kuvvetle geri
 * cevrilebilir; sir olmadan ozet uretilemez. Ozet YALNIZCA kisa omurlu Redis
 * sayac anahtarlari icindir ve yine kisisel veridir (anonim degildir).
 * `hashToken` ile ayni anahtar kullanilir ama mesaj `pseudonym:v1:` onekini
 * tasir; ham token base64url oldugu icin `:` icermez, alanlar cakismaz.
 */
export function pseudonymize(purpose: PseudonymPurpose, value: string): string {
  return createHmac("sha256", secret()).update(`pseudonym:v1:${purpose}\0${value}`).digest("hex");
}

/** 256 bit rastgele token, URL'ye gomulebilir (base64url, dolgusuz). */
export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `SESSION_SECRET` pepper'i ile HMAC-SHA256. Duz SHA-256 degil - bkz. plan 0006. */
export function hashToken(rawToken: string): string {
  return createHmac("sha256", secret()).update(rawToken).digest("hex");
}
