/**
 * Paylaşılan SMTP taşıyıcısı - `auth/send-login-email.ts` ve
 * `account/send-alert-email.ts` aynı bağlantı havuzunu kullanır. Yerelde
 * Mailpit, üretimde Resend/Postmark'ın SMTP ucu; tek kod yolu.
 */
import nodemailer, { type Transporter } from "nodemailer";

let cached: Transporter | undefined;

export function getSmtpTransport(): Transporter {
  if (cached) return cached;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  if (!host || !port) {
    throw new Error("SMTP_HOST/SMTP_PORT tanimli degil. .env.example dosyasina bakin.");
  }
  cached = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: false,
  });
  return cached;
}

export function emailFrom(): string {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM tanimli degil. .env.example dosyasina bakin.");
  }
  return from;
}
