/**
 * Telefonla giris: SMS ile tek kullanimlik kod.
 *
 * - Numara E.164'e normalize edilir; kimlik `user_identity (phone, +90...)`.
 * - Kod duz metin saklanmaz: `hashToken` (HMAC-SHA256, SESSION_SECRET) ile,
 *   numarayla birlikte. 6 haneli kodun duz SHA-256'si bir milyon denemede
 *   cozulurdu; anahtarli hash veritabani sizintisinda bunu engeller.
 * - Sureli (`PHONE_CODE_TTL_MINUTES`, varsayilan 10), tek kullanimlik
 *   (`consumed_at`), kod basina en fazla `PHONE_CODE_MAX_ATTEMPTS` yanlis deneme.
 * - Oran siniri: gonderimde telefon ve IP basina, dogrulamada IP basina.
 *   Redis yoksa kapali kalinir (e-posta girisiyle ayni, decision 0006).
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { type Database, phoneLoginCode } from "@arilla/db";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getRedis } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import { type SignInWithIdentityResult, signInWithIdentity } from "./identity-sign-in.ts";
import { RateLimitExceededError } from "./rate-limit.ts";
import { SmsDeliveryError, type SmsSender } from "./sms.ts";
import { hashToken } from "./token.ts";

export const PHONE_CODE_LENGTH = 6;
export const PHONE_CODE_MAX_ATTEMPTS = 5;

const PHONE_WINDOW_SECONDS = 60;
const PHONE_MAX_REQUESTS = 1;
const PHONE_HOURLY_WINDOW_SECONDS = 60 * 60;
const PHONE_HOURLY_MAX_REQUESTS = 5;
const IP_SEND_WINDOW_SECONDS = 60 * 60;
const IP_SEND_MAX_REQUESTS = 10;
const IP_VERIFY_WINDOW_SECONDS = 60 * 60;
const IP_VERIFY_MAX_REQUESTS = 30;

function codeTtlMinutes(): number {
  const value = Number(process.env.PHONE_CODE_TTL_MINUTES ?? 10);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

export class InvalidPhoneNumberError extends Error {
  constructor() {
    super("gecersiz telefon numarasi");
    this.name = "InvalidPhoneNumberError";
  }
}

/** Kod yanlis, suresi dolmus, kullanilmis ya da deneme hakki bitmis - ayrim disari sizmaz. */
export class PhoneCodeInvalidError extends Error {
  constructor() {
    super("telefon kodu gecersiz");
    this.name = "PhoneCodeInvalidError";
  }
}

/**
 * E.164'e normalize eder; yerel yazim Turkiye (+90) varsayar.
 *   "0532 123 45 67", "532 123 45 67", "+90 (532) 123-45-67", "0090532..."
 *   -> "+905321234567". Anlasilamazsa `null`.
 */
export function normalizePhoneE164(raw: string, defaultCountryCode = "90"): string | null {
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/[\s().-]/g, "");

  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 11) {
    digits = `${defaultCountryCode}${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `${defaultCountryCode}${digits}`;
  } else {
    return null;
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // Turkiye numarasi: ulke kodu + 10 hane.
  if (digits.startsWith("90") && digits.length !== 12) return null;
  return `+${digits}`;
}

function hashCode(phone: string, code: string): string {
  // Numara karisir: ayni kod baska bir numara icin ayni hash'i vermez.
  return hashToken(`phone-login:${phone}:${code}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Telefon ve IP anahtara duz yazilmaz (rate-limit.ts ile ayni gerekce). */
export function phoneRateLimitKeys(input: { phone: string; ip: string | null }) {
  return {
    phoneKey: `ratelimit:auth:phone:${digest(input.phone)}`,
    phoneHourlyKey: `ratelimit:auth:phone-hour:${digest(input.phone)}`,
    ipSendKey: input.ip ? `ratelimit:auth:phone-ip:${digest(input.ip.trim())}` : null,
    ipVerifyKey: input.ip ? `ratelimit:auth:phone-verify-ip:${digest(input.ip.trim())}` : null,
  };
}

export async function checkPhoneSendRateLimit(input: {
  phone: string;
  ip: string | null;
}): Promise<void> {
  const keys = phoneRateLimitKeys(input);
  if ((await incrementFixedWindow(keys.phoneKey, PHONE_WINDOW_SECONDS)) > PHONE_MAX_REQUESTS) {
    throw new RateLimitExceededError("phone");
  }
  if (
    (await incrementFixedWindow(keys.phoneHourlyKey, PHONE_HOURLY_WINDOW_SECONDS)) >
    PHONE_HOURLY_MAX_REQUESTS
  ) {
    throw new RateLimitExceededError("phone");
  }
  if (
    keys.ipSendKey &&
    (await incrementFixedWindow(keys.ipSendKey, IP_SEND_WINDOW_SECONDS)) > IP_SEND_MAX_REQUESTS
  ) {
    throw new RateLimitExceededError("ip");
  }
}

export async function checkPhoneVerifyRateLimit(input: { ip: string | null }): Promise<void> {
  const { ipVerifyKey } = phoneRateLimitKeys({ phone: "", ip: input.ip });
  if (
    ipVerifyKey &&
    (await incrementFixedWindow(ipVerifyKey, IP_VERIFY_WINDOW_SECONDS)) > IP_VERIFY_MAX_REQUESTS
  ) {
    throw new RateLimitExceededError("ip");
  }
}

/** SMS gitmediyse numaranin 60 saniyelik hakki geri verilir (rate-limit.ts ile ayni desen). */
async function releasePhoneRateLimit(phone: string): Promise<void> {
  try {
    await getRedis().del(phoneRateLimitKeys({ phone, ip: null }).phoneKey);
  } catch {
    // en iyi caba
  }
}

export function generatePhoneCode(): string {
  return String(randomInt(0, 10 ** PHONE_CODE_LENGTH)).padStart(PHONE_CODE_LENGTH, "0");
}

export interface RequestPhoneLoginCodeOptions {
  /** Testler Redis'siz calissin diye; varsayilan gercek oran siniri. */
  checkRateLimit?: (input: { phone: string; ip: string | null }) => Promise<void>;
  generateCode?: () => string;
  now?: Date;
}

/**
 * Kod uretir, hash'ini yazar, SMS gonderir. `phone` E.164 olmalidir
 * (`normalizePhoneE164`); degilse `InvalidPhoneNumberError`.
 */
export async function requestPhoneLoginCode(
  db: Database,
  input: { phone: string; ip: string | null },
  sender: SmsSender,
  options: RequestPhoneLoginCodeOptions = {},
): Promise<{ codeId: number }> {
  const phone = normalizePhoneE164(input.phone);
  if (!phone) throw new InvalidPhoneNumberError();

  await (options.checkRateLimit ?? checkPhoneSendRateLimit)({ phone, ip: input.ip });

  const code = (options.generateCode ?? generatePhoneCode)();
  const now = options.now ?? new Date();
  const [row] = await db
    .insert(phoneLoginCode)
    .values({
      phone,
      codeHash: hashCode(phone, code),
      expiresAt: new Date(now.getTime() + codeTtlMinutes() * 60 * 1000),
      requestIp: input.ip,
    })
    .returning({ id: phoneLoginCode.id });
  if (!row) throw new Error("phone_login_code insert bos sonuc dondurdu");

  try {
    await sender.send({
      to: phone,
      body: `Arilla giriş kodun: ${code}. Kod ${codeTtlMinutes()} dakika geçerli. Kimseyle paylaşma.`,
    });
  } catch (error) {
    // Gonderilmemis kod kullanilamaz kalsin; kullanicinin hakki geri verilir.
    await db
      .update(phoneLoginCode)
      .set({ consumedAt: now })
      .where(eq(phoneLoginCode.id, row.id))
      .catch(() => undefined);
    if (!options.checkRateLimit) await releasePhoneRateLimit(phone);
    throw new SmsDeliveryError({ cause: error });
  }
  return { codeId: row.id };
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface VerifyPhoneLoginCodeInput {
  phone: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
}

export interface VerifyPhoneLoginCodeOptions {
  checkRateLimit?: (input: { ip: string | null }) => Promise<void>;
  now?: Date;
}

/**
 * Kodu dogrular ve tuketir; dogruysa kullaniciyi telefon kimligiyle bulur
 * ya da acar ve oturum olusturur (`signInWithPhone`). Yanlis kod oturum
 * olusturmaz, deneme sayisini arttirir.
 */
export async function signInWithPhone(
  db: Database,
  input: VerifyPhoneLoginCodeInput,
  options: VerifyPhoneLoginCodeOptions = {},
): Promise<SignInWithIdentityResult> {
  const phone = normalizePhoneE164(input.phone);
  const code = input.code.replace(/\s/g, "");
  if (!phone || !new RegExp(`^\\d{${PHONE_CODE_LENGTH}}$`).test(code)) {
    throw new PhoneCodeInvalidError();
  }

  await (options.checkRateLimit ?? checkPhoneVerifyRateLimit)({ ip: input.ip });

  const now = options.now ?? new Date();
  // Yalnizca en yeni gecerli kod: yeni kod istendiginde eskisi kullanilamaz.
  const rows = await db
    .select({
      id: phoneLoginCode.id,
      codeHash: phoneLoginCode.codeHash,
      attempts: phoneLoginCode.attempts,
    })
    .from(phoneLoginCode)
    .where(
      and(
        eq(phoneLoginCode.phone, phone),
        isNull(phoneLoginCode.consumedAt),
        gt(phoneLoginCode.expiresAt, now),
      ),
    )
    .orderBy(desc(phoneLoginCode.createdAt), desc(phoneLoginCode.id))
    .limit(1);
  const row = rows[0];
  if (!row || row.attempts >= PHONE_CODE_MAX_ATTEMPTS) throw new PhoneCodeInvalidError();

  if (!sameHash(row.codeHash, hashCode(phone, code))) {
    await db
      .update(phoneLoginCode)
      .set({ attempts: sql`${phoneLoginCode.attempts} + 1` })
      .where(eq(phoneLoginCode.id, row.id));
    throw new PhoneCodeInvalidError();
  }

  // Atomik tuketim: esanli iki dogrulamadan yalnizca biri gecer.
  const consumed = await db
    .update(phoneLoginCode)
    .set({ consumedAt: now })
    .where(
      and(
        eq(phoneLoginCode.id, row.id),
        isNull(phoneLoginCode.consumedAt),
        lt(phoneLoginCode.attempts, PHONE_CODE_MAX_ATTEMPTS),
      ),
    )
    .returning({ id: phoneLoginCode.id });
  if (!consumed[0]) throw new PhoneCodeInvalidError();

  return signInWithIdentity(db, {
    provider: "phone",
    subject: phone,
    email: null,
    emailVerified: false,
    displayName: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}
