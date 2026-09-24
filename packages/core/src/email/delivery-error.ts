/**
 * Gönderim başarısız olduğunda çağırana dürüstçe yüzeye çıkan hata. Mesaj
 * kişisel veri (alıcı adresi, token'lı bağlantı) içermez; özgün hata
 * `cause` içinde durur ve loglanmamalıdır (sağlayıcı mesajı alıcıyı
 * içerebilir). Loglamak için yalnızca `code` kullanılır.
 */
export class EmailDeliveryError extends Error {
  /** nodemailer hata kodu (EAUTH, ECONNECTION, ETIMEDOUT ...) veya yapılandırma hatası için "ECONFIG". */
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(`E-posta gonderilemedi (${code}).`, options);
    this.name = "EmailDeliveryError";
    this.code = code;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "SmtpConfigError") return "ECONFIG";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  }
  return "EUNKNOWN";
}

/** Herhangi bir gönderim/yapılandırma hatasını `EmailDeliveryError`'a sarar. */
export function toEmailDeliveryError(error: unknown): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;
  return new EmailDeliveryError(errorCode(error), { cause: error });
}
