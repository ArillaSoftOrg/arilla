import { classifyError, type PublicError, reportError } from "@arilla/core/errors";

/**
 * Sunucu eyleminde yakalanan hatayi siniflar, guvenli loglar ve istemciye
 * yalnizca `{code, reference}` doner (karar 0104). Mesaj, yigin ya da
 * surucu ayrintisi donmez. Asla firlatmaz.
 */
export function actionError(error: unknown, surface: string): PublicError {
  return reportError(error, { surface });
}

/** Oturum bitti ya da yok: istemci yeniden giris ister, girdiler korunur. */
export const SESSION_EXPIRED: PublicError = { code: "session_expired" };

/**
 * Sohbet turunun saglayici hata kodu (zaten sunucuda kaydedilmis) -> kullanici
 * hatasi. `unknown` ise neden bilinmez; kod uydurulmaz, `null` doner ve eski
 * genel metin kalir.
 */
export function errorFromLlmCode(code: string): PublicError | null {
  const mapped = classifyError({ name: "LlmError", code });
  return mapped === "unknown" ? null : { code: mapped };
}
