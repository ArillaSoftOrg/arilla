/**
 * Ham token buraya parametre olarak girer ve yalnizca e-posta govdesindeki
 * baglantiya gomulur - hicbir yerde loglanmaz (decision 0006 madde 2).
 * Taşıyıcı `../email/transport.ts`'te paylaşılır (`account/send-alert-
 * email.ts` ile aynı bağlantı havuzu).
 *
 * Gönderim veya SMTP yapılandırma hatası `EmailDeliveryError` olarak
 * fırlatılır; çağıran "gönderdik" demeden önce bunu ele almak zorunda.
 */
import { toEmailDeliveryError } from "../email/delivery-error.ts";
import { escapeHtml } from "../email/escape-html.ts";
import { emailFrom, getSmtpTransport } from "../email/transport.ts";

export interface SendLoginEmailInput {
  email: string;
  loginUrl: string;
}

export function buildLoginEmail(loginUrl: string): { subject: string; text: string; html: string } {
  const url = escapeHtml(loginUrl);
  return {
    // docs/copy.md `email.login_subject`
    subject: "Giriş bağlantın",
    text: `Giriş yapmak için bağlantıya tıkla (15 dakika geçerli): ${loginUrl}`,
    html: `<p>Giriş yapmak için bağlantıya tıkla (15 dakika geçerli):</p><p><a href="${url}">${url}</a></p>`,
  };
}

export async function sendLoginEmail(input: SendLoginEmailInput): Promise<void> {
  try {
    await getSmtpTransport().sendMail({
      from: emailFrom(),
      to: input.email,
      ...buildLoginEmail(input.loginUrl),
    });
  } catch (error) {
    throw toEmailDeliveryError(error);
  }
}
