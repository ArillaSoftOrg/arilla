/**
 * Gönderim hatasının sınıfı (saf, docs/decisions/0048). Tek ilke: yalnızca
 * sağlayıcının iletiyi KESİN almadığı durum yeniden denenir. Sonucu belirsiz
 * hata (veri aktarımı sırasında zaman aşımı, kopan bağlantı) yeniden
 * denenmez — aynı kişiye iki kampanya iletisi gitmesindense tek teslimin
 * `unknown_outcome` kalması tercih edilir.
 *
 * nodemailer hata alanları: `code` (EAUTH, ECONNECTION, ETIMEDOUT, EENVELOPE,
 * EMESSAGE ...), `responseCode` (SMTP yanıt kodu), `command` (hatanın
 * olduğu SMTP adımı: CONN, EHLO, AUTH ..., MAIL FROM, RCPT TO, DATA).
 * Ham sağlayıcı mesajı (`response`) alıcı adresini içerebilir; saklanmaz.
 */
import type { MarketingFailureCode } from "@arilla/db";
import { toEmailDeliveryError } from "../email/delivery-error.ts";

export type SendErrorOutcome =
  /** Yapılandırma: tek teslim değil, tüm iş yanlış. Teslim tüketilmez, iş durur. */
  | { kind: "configuration"; providerCode: string }
  /** Sağlayıcı kesin reddetti ya da hiç bağlanılamadı: deneme hakkı varsa yeniden. */
  | { kind: "retryable"; providerCode: string }
  | { kind: "permanent"; failureCode: MarketingFailureCode; providerCode: string };

/** Bu adımlarda hata = ileti verisi henüz gönderilmedi. */
const PRE_DATA_COMMANDS = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH\b.*|MAIL FROM|RCPT TO)$/i;

function field(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

export function classifySendError(error: unknown): SendErrorOutcome {
  const code = toEmailDeliveryError(error).code;
  const responseCode = field(error, "responseCode");
  const command = field(error, "command");
  const status = typeof responseCode === "number" ? responseCode : null;
  const providerCode = status ? `${code}_${status}`.slice(0, 32) : code;

  if (
    code === "ECONFIG" ||
    code === "EAUTH" ||
    code === "ENOAUTH" ||
    code === "ETLS" ||
    (error instanceof Error && error.name === "MarketingConfigError")
  ) {
    return { kind: "configuration", providerCode };
  }

  if (status !== null) {
    if (status >= 400 && status < 500) return { kind: "retryable", providerCode };
    if (status >= 500) {
      const recipientStep =
        code === "EENVELOPE" || (typeof command === "string" && /RCPT/i.test(command));
      return {
        kind: "permanent",
        failureCode: recipientStep ? "invalid_recipient" : "provider_rejected",
        providerCode,
      };
    }
  }

  if (code === "EENVELOPE") {
    return { kind: "permanent", failureCode: "invalid_recipient", providerCode };
  }
  if (code === "ECONNECTION" || code === "EDNS") return { kind: "retryable", providerCode };
  if (
    (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNRESET") &&
    typeof command === "string" &&
    PRE_DATA_COMMANDS.test(command)
  ) {
    return { kind: "retryable", providerCode };
  }
  return { kind: "permanent", failureCode: "unknown_outcome", providerCode };
}

/** Geçici hatada sonraki deneme: 5, 10, 20 ... dakika (en fazla 60). */
export function retryDelayMs(attemptCount: number): number {
  const minutes = Math.min(60, 5 * 2 ** Math.max(0, attemptCount - 1));
  return minutes * 60 * 1000;
}
