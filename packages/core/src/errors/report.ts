/**
 * Sunucu tarafi hata kaydi (karar 0104). Bir hatayi siniflar, kisa bir
 * referans kimligi uretir ve GUVENLI tek satirlik JSON loglar. Loga yalnizca
 * kod, hata sinifi adi, surucu kodu ve temizlenmis kisa metin girer: URL,
 * sunucu adi, kullanici girdisi ve yigin yazilmaz. Asla firlatmaz.
 */
import type { ErrorCode, PublicError } from "./catalog.ts";
import { type ClassifyOptions, classifyError } from "./classify.ts";

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** `ARL-XXXXXXXX`: karisabilecek karakterler (0/O, 1/I) yok. */
export function newErrorReference(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `ARL-${out}`;
}

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi;
const HOST_PORT = /\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?::\d{2,5})?\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;
const MAX_MESSAGE = 200;

/** Baglanti adresi, sunucu adi ve anahtar benzeri dizgileri siler. */
export function scrubMessage(raw: string): string {
  return raw
    .replace(URL_LIKE, "[url]")
    .replace(HOST_PORT, "[host]")
    .replace(LONG_TOKEN, "[token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

export interface ErrorContext {
  /** Sabit yuzey adi (or. `sohbet.send`); kullanici girdisi degil. */
  surface: string;
  /** Next'in opak `digest`'i varsa referans olarak o kullanilir. */
  digest?: string;
  options?: ClassifyOptions;
}

export interface ErrorLogRecord {
  event: "app_error";
  reference: string;
  code: ErrorCode;
  surface: string;
  errorName: string;
  driverCode?: string;
  httpStatus?: number;
  message: string;
}

/** Log kaydini kurar (test edilebilir, yazmaz). */
export function buildErrorLog(
  error: unknown,
  code: ErrorCode,
  reference: string,
  surface: string,
): ErrorLogRecord {
  const like =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    event: "app_error",
    reference,
    code,
    surface,
    errorName: typeof like.name === "string" ? like.name : typeof error,
    ...(typeof like.code === "string" ? { driverCode: like.code.slice(0, 32) } : {}),
    ...(typeof like.httpStatus === "number" ? { httpStatus: like.httpStatus } : {}),
    message: scrubMessage(typeof like.message === "string" ? like.message : ""),
  };
}

/** Siniflar, loglar ve istemciye gidecek `{code, reference}` doner. */
export function reportError(error: unknown, context: ErrorContext): PublicError {
  let reference = context.digest || "";
  let code: ErrorCode = "unknown";
  try {
    code = classifyError(error, context.options);
    reference ||= newErrorReference();
    console.error(JSON.stringify(buildErrorLog(error, code, reference, context.surface)));
  } catch {
    reference ||= "ARL-UNLOGGED";
  }
  return { code, reference };
}
