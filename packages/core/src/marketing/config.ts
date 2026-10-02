/**
 * Pazarlama e-postası gönderim yapılandırması (docs/decisions/0048). Saf
 * fonksiyon: ağ ve veritabanı yok. Hata mesajları değişken DEĞERİ içermez,
 * yalnızca adını.
 *
 * İki kapı:
 *
 * 1. **Test gönderimi** (yöneticinin yazdığı tek adres): SMTP yapılandırılmış
 *    her ortamda. Yerelde Mailpit'e düşer.
 * 2. **Gerçek (toplu) gönderim** yalnızca şu iki durumda açıktır:
 *    - SMTP yerel röle (localhost/mailpit): ileti makineden çıkmaz; yerel
 *      veritabanındaki adresler Mailpit'te görünür, gerçek kutuya gitmez.
 *    - `VERCEL_ENV=production` VE `MARKETING_EMAIL_ENABLED=true`: üretimde
 *      bilinçli açma anahtarı. Preview, yanlış `.env` ya da gerçek SMTP'li
 *      bir geliştirici makinesi gerçek kullanıcılara kampanya gönderemez.
 *
 * Gönderen: `MARKETING_EMAIL_FROM` (işlemsel `EMAIL_FROM`'dan ayrı itibar).
 * Üretimde zorunlu; yerelde boşsa `EMAIL_FROM` kullanılır.
 */
import { SmtpConfigError, smtpConfigFromEnv } from "../email/transport.ts";

type Env = Readonly<Record<string, string | undefined>>;

const LOCAL_RELAY_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "mailpit"]);

export class MarketingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingConfigError";
  }
}

export type BulkSendBlock = "disabled_in_production" | "non_production_remote_smtp";

export interface MarketingEmailConfig {
  from: string;
  replyTo: string | null;
  /** Gerçek alıcılara gönderim bu ortamda açık mı. */
  bulkSendAllowed: boolean;
  bulkSendBlock: BulkSendBlock | null;
  /** Tek toplu işlemde en fazla ileti. */
  batchSize: number;
  /** İki ileti arası bekleme (sağlayıcı hız sınırı). */
  sendIntervalMs: number;
  /** Toplu işlemin süre bütçesi; aşılınca yeni ileti alınmaz. */
  timeBudgetMs: number;
  /** Geçici hatada alıcı başına en fazla deneme (ilk deneme dahil). */
  maxAttempts: number;
  /** Bu süreden eski `sending` satırı belirsiz sonuçla kapanır, yeniden denenmez. */
  staleSendingMs: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function intFromEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new MarketingConfigError(`${name} gecerli bir tamsayi degil.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MarketingConfigError(`${name} ${min}-${max} araliginda olmali.`);
  }
  return value;
}

/** `Ad <adres@alan>` ya da çıplak adres; yalnızca biçim. */
function isAddressShape(value: string): boolean {
  const match = /<([^<>]+)>\s*$/.exec(value);
  const address = (match ? match[1] : value)?.trim() ?? "";
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address);
}

export function isLocalSmtpRelay(env: Env): boolean {
  try {
    return LOCAL_RELAY_HOSTS.has(smtpConfigFromEnv(env).host.toLowerCase());
  } catch {
    return false;
  }
}

function isVercelProduction(env: Env): boolean {
  return env.VERCEL_ENV?.trim() === "production";
}

/**
 * SMTP yapılandırması da burada doğrulanır (`SmtpConfigError` →
 * `MarketingConfigError`): toplu iş hiçbir teslimi yapılandırma hatası
 * yüzünden tüketmesin diye döngüden ÖNCE çağrılır.
 */
export function marketingEmailConfigFromEnv(env: Env = process.env): MarketingEmailConfig {
  try {
    smtpConfigFromEnv(env);
  } catch (error) {
    if (error instanceof SmtpConfigError) throw new MarketingConfigError(error.message);
    throw error;
  }

  const production = isVercelProduction(env);
  const from =
    nonEmpty(env.MARKETING_EMAIL_FROM) ?? (production ? undefined : nonEmpty(env.EMAIL_FROM));
  if (!from) {
    throw new MarketingConfigError(
      production
        ? "MARKETING_EMAIL_FROM tanimli degil (uretimde zorunlu). .env.example dosyasina bakin."
        : "MARKETING_EMAIL_FROM ve EMAIL_FROM tanimli degil. .env.example dosyasina bakin.",
    );
  }
  if (!isAddressShape(from)) {
    throw new MarketingConfigError("MARKETING_EMAIL_FROM gecerli bir adres degil.");
  }
  const replyTo = nonEmpty(env.MARKETING_EMAIL_REPLY_TO) ?? null;
  if (replyTo && !isAddressShape(replyTo)) {
    throw new MarketingConfigError("MARKETING_EMAIL_REPLY_TO gecerli bir adres degil.");
  }

  let bulkSendBlock: BulkSendBlock | null = null;
  if (!isLocalSmtpRelay(env)) {
    if (!production) {
      bulkSendBlock = "non_production_remote_smtp";
    } else if (nonEmpty(env.MARKETING_EMAIL_ENABLED)?.toLowerCase() !== "true") {
      bulkSendBlock = "disabled_in_production";
    }
  }

  return {
    from,
    replyTo,
    bulkSendAllowed: bulkSendBlock === null,
    bulkSendBlock,
    // Varsayılanlar Resend'in varsayılan hız sınırının (saniyede 2 istek)
    // altında kalır ve Vercel işlev süresine sığar: 40 ileti x 500 ms.
    batchSize: intFromEnv(env, "MARKETING_EMAIL_BATCH_SIZE", 40, 1, 500),
    sendIntervalMs: intFromEnv(env, "MARKETING_EMAIL_SEND_INTERVAL_MS", 500, 0, 10_000),
    timeBudgetMs: intFromEnv(env, "MARKETING_EMAIL_TIME_BUDGET_MS", 25_000, 1_000, 280_000),
    maxAttempts: intFromEnv(env, "MARKETING_EMAIL_MAX_ATTEMPTS", 3, 1, 5),
    staleSendingMs: 10 * 60 * 1000,
  };
}

/** Yönetim ekranı için açıklama; değer içermez. */
export function bulkSendBlockMessage(block: BulkSendBlock): string {
  return block === "disabled_in_production"
    ? "Gerçek gönderim üretimde kapalı (MARKETING_EMAIL_ENABLED)."
    : "Bu ortamda gerçek gönderim kapalı: SMTP yerel Mailpit değil ve ortam üretim değil.";
}
