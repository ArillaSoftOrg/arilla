/**
 * İki e-posta türü kesin ayrıdır (docs/decisions/0046):
 *
 * - İşlemsel ileti (giriş bağlantısı, fiyat alarmı, hesap/güvenlik
 *   bildirimi) buradan, `EMAIL_FROM` ile gider. Pazarlama rızasına BAKMAZ;
 *   rıza geri alınsa da giriş e-postası gelmeye devam eder. Tanıtım metni
 *   ve abonelik iptal bağlantısı eklenmez.
 * - Ticari ileti bu dosyadan GİTMEZ: tek yolu
 *   `marketing/send-marketing-email.ts` (rıza + bastırma + ortam kapısı).
 *
 * Özellik kodu `getSmtpTransport().sendMail` çağırmaz; ya bunu ya da
 * pazarlama göndericisini kullanır.
 */
import type { Transporter } from "nodemailer";
import { toEmailDeliveryError } from "./delivery-error.ts";
import { emailFrom, getSmtpTransport } from "./transport.ts";

/** Testlerde sahte taşıyıcı verilebilsin diye yalnızca kullanılan yüzey. */
export type EmailTransport = Pick<Transporter, "sendMail">;

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface TransactionalEmail extends EmailContent {
  to: string;
}

/** Başarısızlık `EmailDeliveryError` olarak fırlar; mesajı adres/token içermez. */
export async function sendTransactionalEmail(
  message: TransactionalEmail,
  transport?: EmailTransport,
): Promise<void> {
  try {
    await (transport ?? getSmtpTransport()).sendMail({
      from: emailFrom(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (error) {
    throw toEmailDeliveryError(error);
  }
}
