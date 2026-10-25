/**
 * E-posta/sifre akisinin e-postalari (karar 0150, 0151): dogrulama, hos geldin,
 * sifre sifirlama, sifre degisikligi bildirimi, hesaba sifre ekleme ve "bu
 * adresle hesap var". Sablonlar `email/transactional-templates.ts`'te; baglanti
 * yalnizca govdeye gomulur, loglanmaz. Gonderim hatasi `EmailDeliveryError`
 * olarak firlar. Tasiyici `../email/transport.ts` (giris baglantisiyla ayni
 * SMTP havuzu); gonderen `EMAIL_FROM`, yanit adresi `EMAIL_REPLY_TO`.
 */
import { toEmailDeliveryError } from "../email/delivery-error.ts";
import {
  buildTransactionalEmail,
  type TransactionalEmailKind,
} from "../email/transactional-templates.ts";
import { emailFrom, emailReplyTo, getSmtpTransport } from "../email/transport.ts";

export { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_MINUTES } from "./token-ttl.ts";

export type CredentialEmailKind = TransactionalEmailKind;

export interface CredentialEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function buildCredentialEmail(
  kind: CredentialEmailKind,
  url?: string,
): CredentialEmailContent {
  return buildTransactionalEmail(kind, url);
}

export async function sendCredentialEmail(input: {
  kind: CredentialEmailKind;
  email: string;
  /** `password_changed` disinda zorunlu. */
  url?: string;
}): Promise<void> {
  try {
    await getSmtpTransport().sendMail({
      from: emailFrom(),
      replyTo: emailReplyTo(),
      to: input.email,
      ...buildCredentialEmail(input.kind, input.url),
    });
  } catch (error) {
    throw toEmailDeliveryError(error);
  }
}

/**
 * Bilgilendirme e-postalari (hos geldin, sifre degisti): islem zaten
 * tamamlanmistir, gonderim hatasi kullanicinin islemini bozmaz. Hata yalnizca
 * kodu ile loglanir (adres/baglanti/token loglanmaz).
 */
/** Bilgilendirme e-postasi icin yanitin en fazla bekleyecegi sure. */
const NOTICE_WAIT_MS = 4000;

export async function sendCredentialNoticeBestEffort(
  input: Parameters<typeof sendCredentialEmail>[0],
): Promise<void> {
  const send = sendCredentialEmail(input).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    console.error(`[giris] ${input.kind} notice delivery failed: ${code}`);
  });
  // Yanit, takili bir SMTP baglantisini (nodemailer varsayilani dakikalar) beklemez;
  // gonderim arka planda surer ve hatasi yukaridaki catch ile loglanir.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, NOTICE_WAIT_MS);
  });
  try {
    await Promise.race([send, budget]);
  } finally {
    clearTimeout(timer);
  }
}
