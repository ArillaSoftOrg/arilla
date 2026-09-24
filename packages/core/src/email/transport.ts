/**
 * Paylaşılan SMTP taşıyıcısı - `auth/send-login-email.ts` ve
 * `account/send-alert-email.ts` aynı bağlantı havuzunu kullanır. Yerelde
 * Mailpit (kimlik doğrulamasız), üretimde sağlayıcının SMTP ucu
 * (Resend/Postmark/SES vb., kullanıcı adı + parola ile); tek kod yolu.
 *
 * Ortam değişkenleri: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_SECURE (isteğe bağlı), EMAIL_FROM. Hata mesajları hiçbir zaman
 * değişken DEĞERİ içermez - yalnızca adını.
 */
import nodemailer, { type Transporter } from "nodemailer";

/** Yalnızca bu hostlar kimlik doğrulamasız (yerel geliştirme rölesi) kabul edilir. */
const LOCAL_RELAY_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "mailpit"]);

export class SmtpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpConfigError";
  }
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  /** true: doğrudan TLS (genelde 465). false: düz bağlantı, STARTTLS ile yükseltme. */
  secure: boolean;
  /** Kimlik bilgisi düz metin bağlantıda asla gönderilmesin diye STARTTLS zorunlu. */
  requireTLS: boolean;
  auth?: { user: string; pass: string };
}

type SmtpEnv = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isLocalRelayHost(host: string): boolean {
  return LOCAL_RELAY_HOSTS.has(host.toLowerCase());
}

/**
 * Saf karar fonksiyonu: ortamdan taşıyıcı seçeneklerini üretir veya
 * açık bir `SmtpConfigError` fırlatır. Ağ erişimi yok.
 */
export function smtpConfigFromEnv(env: SmtpEnv): SmtpTransportOptions {
  const host = nonEmpty(env.SMTP_HOST);
  const portRaw = nonEmpty(env.SMTP_PORT);
  if (!host || !portRaw) {
    throw new SmtpConfigError("SMTP_HOST/SMTP_PORT tanimli degil. .env.example dosyasina bakin.");
  }

  if (!/^\d+$/.test(portRaw)) {
    throw new SmtpConfigError("SMTP_PORT gecerli bir tamsayi degil.");
  }
  const port = Number(portRaw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new SmtpConfigError("SMTP_PORT 1-65535 araliginda olmali.");
  }

  const secureRaw = nonEmpty(env.SMTP_SECURE)?.toLowerCase();
  let secure: boolean;
  if (secureRaw === undefined) {
    secure = port === 465;
  } else if (secureRaw === "true") {
    secure = true;
  } else if (secureRaw === "false") {
    secure = false;
  } else {
    throw new SmtpConfigError('SMTP_SECURE yalnizca "true" veya "false" olabilir.');
  }

  // Parola bilerek trim edilmez: bosluk parolanin parcasi olabilir. Yalnizca
  // tamamen bos/whitespace deger "tanimsiz" sayilir.
  const user = nonEmpty(env.SMTP_USER);
  const pass = env.SMTP_PASS?.trim() ? env.SMTP_PASS : undefined;

  if ((user === undefined) !== (pass === undefined)) {
    throw new SmtpConfigError(
      "SMTP_USER ve SMTP_PASS birlikte tanimlanmali (biri eksik). .env.example dosyasina bakin.",
    );
  }

  if (user !== undefined && pass !== undefined) {
    return {
      host,
      port,
      secure,
      // Dogrudan TLS degilse STARTTLS zorunlu: sunucu desteklemiyorsa
      // kimlik bilgisi gonderilmeden baglanti reddedilir.
      requireTLS: !secure,
      auth: { user, pass },
    };
  }

  // Kimlik dogrulamasiz yalnizca yerel gelistirme rolesi (Mailpit).
  if (!isLocalRelayHost(host)) {
    const production = env.NODE_ENV === "production";
    throw new SmtpConfigError(
      production
        ? "Uretimde SMTP_USER/SMTP_PASS zorunlu: kimlik dogrulamasiz SMTP yalnizca yerel gelistirme rolesi (localhost/mailpit) icin."
        : "SMTP_USER/SMTP_PASS tanimli degil: kimlik dogrulamasiz SMTP yalnizca yerel gelistirme rolesi (localhost/mailpit) icin.",
    );
  }

  return { host, port, secure, requireTLS: false };
}

let cached: Transporter | undefined;

export function getSmtpTransport(): Transporter {
  if (cached) return cached;
  cached = nodemailer.createTransport(smtpConfigFromEnv(process.env));
  return cached;
}

/**
 * Operasyon kontrolu: SMTP sunucusuna baglanip (varsa) kimlik dogrulamasini
 * dener, e-posta gondermez. Import aninda cagrilmaz.
 */
export async function verifySmtpTransport(): Promise<void> {
  await getSmtpTransport().verify();
}

export function emailFrom(): string {
  const from = nonEmpty(process.env.EMAIL_FROM);
  if (!from) {
    throw new SmtpConfigError("EMAIL_FROM tanimli degil. .env.example dosyasina bakin.");
  }
  return from;
}
