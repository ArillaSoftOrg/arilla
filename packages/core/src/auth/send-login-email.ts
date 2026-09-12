/**
 * Ham token buraya parametre olarak girer ve yalnizca e-posta govdesindeki
 * baglantiya gomulur - hicbir yerde loglanmaz (decision 0006 madde 2).
 * Taşıyıcı `../email/transport.ts`'te paylaşılır (`account/send-alert-
 * email.ts` ile aynı bağlantı havuzu).
 */
import { emailFrom, getSmtpTransport } from "../email/transport.ts";

export interface SendLoginEmailInput {
  email: string;
  loginUrl: string;
}

export async function sendLoginEmail(input: SendLoginEmailInput): Promise<void> {
  await getSmtpTransport().sendMail({
    from: emailFrom(),
    to: input.email,
    // docs/copy.md `email.login_subject`
    subject: "Giriş bağlantın",
    text: `Giriş yapmak için bağlantıya tıkla (15 dakika geçerli): ${input.loginUrl}`,
    html: `<p>Giriş yapmak için bağlantıya tıkla (15 dakika geçerli):</p><p><a href="${input.loginUrl}">${input.loginUrl}</a></p>`,
  });
}
