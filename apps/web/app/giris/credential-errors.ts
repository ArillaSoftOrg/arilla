import {
  EmailDeliveryError,
  InvalidCredentialsError,
  InvalidEmailError,
  isRedisUnavailableError,
  PasswordHashUnavailableError,
  PasswordPolicyError,
  PrivateRelayEmailError,
  RateLimitExceededError,
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
} from "@arilla/core";
import type { CredentialErrorCode } from "./credential-copy.ts";

/**
 * E-posta + şifre sunucu eylemlerinin ortak durum tipi ve hata eşlemesi
 * ("use server" dosyaları yalnızca async eylem dışa aktarabilir; bu yüzden ayrı).
 * Hiçbir yanıt hesabın varlığını belli etmez; şifre ve token loglanmaz.
 */
export type CredentialFormState =
  | { status: "idle" }
  | { status: "error"; code: CredentialErrorCode; email?: string }
  | { status: "sent"; email: string; kind: "register" | "resend" | "forgot" };

/** Bilinen hatayı koda çevirir; bilinmeyen hata yeniden fırlatılır. */
export async function credentialErrorCode(error: unknown): Promise<CredentialErrorCode> {
  if (error instanceof InvalidEmailError) return "invalid_email";
  if (error instanceof InvalidCredentialsError) return "invalid_credentials";
  if (error instanceof PrivateRelayEmailError) return "private_relay";
  if (error instanceof RateLimitExceededError) return "rate_limited";
  if (error instanceof PasswordPolicyError) return error.violation;
  if (error instanceof TokenExpiredError) return "token_expired";
  if (error instanceof TokenAlreadyUsedError || error instanceof TokenNotFoundError) {
    return "token_used";
  }
  if (error instanceof PasswordHashUnavailableError) return "unavailable";
  if (error instanceof EmailDeliveryError) {
    // Yalnızca hata kodu loglanır: alıcı adresi ve bağlantı kayıtlara girmez.
    console.error(`[giris] credential email delivery failed: ${error.code}`);
    return "send_failed";
  }
  if (isRedisUnavailableError(error)) {
    // Oran sınırı doğrulanamıyorsa kapalı kalınır.
    console.error("[giris] rate limit unavailable");
    return "send_failed";
  }
  throw error;
}
