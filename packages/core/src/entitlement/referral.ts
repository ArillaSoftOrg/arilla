/**
 * Davet (docs/decisions/0047 madde 9).
 *
 * - Kod: `app_user.referral_code` (0034, eski 8 karakter, hala gecerli) ve
 *   `referral_public_code` (0051, `YS-49577`, ilk /hesap acilisinda uretilir,
 *   sabit kalir). Baglama her ikisini de arar.
 * - Baglama: `/davet/<kod>` cerezi, YENI hesap acan giriste `pending` davet
 *   kaydina donusur. Mevcut hesaba davet baglanmaz.
 * - Nitelenme: davet edilenin ilk KESINLESEN aramasi (`settleCharge` ile
 *   ayni islem). Kosullu UPDATE (`status = 'pending'`) ikinci kez
 *   nitelenmeyi, `referral:<id>:*` odul anahtarlari ikinci odulu engeller.
 */
import { randomInt } from "node:crypto";
import { type Database, referral } from "@arilla/db";
import { count, eq, sql } from "drizzle-orm";
import { grantBonus } from "./bonus.ts";
import { REWARD_AMOUNTS } from "./config.ts";
import { rows, type Tx, uniqueViolationConstraint } from "./db.ts";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
/** 0051: okunabilir kod, `<2 harf>-<5 rakam>`. */
const PUBLIC_CODE_PATTERN = /^[A-Z]{2}-[0-9]{5}$/;
const FALLBACK_PREFIX = "MC";
const PUBLIC_CODE_ATTEMPTS = 12;

export function generateReferralCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * Kullanicinin yazdigi/linkteki kodu kanonik bicime getirir; gecersizse
 * `null`. Hem eski 8 karakterli (0034) hem yeni `YS-49577` (0051) kabul edilir.
 */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) || PUBLIC_CODE_PATTERN.test(code) ? code : null;
}

const TURKISH_ASCII: Record<string, string> = {
  ç: "C",
  ğ: "G",
  ı: "I",
  ö: "O",
  ş: "S",
  ü: "U",
};

/** Turkce harfleri ASCII buyuk harfe cevirir; A-Z disindaki her sey atilir. */
function asciiLetters(word: string): string {
  let out = "";
  for (const ch of word.normalize("NFC")) {
    // `i` / `İ` ayri ele alinir: Turkce buyuk/kucuk donusumune guvenilmez.
    if (ch === "i" || ch === "İ" || ch === "I") {
      out += "I";
      continue;
    }
    const lower = ch.toLowerCase();
    const mapped = TURKISH_ASCII[lower];
    if (mapped) {
      out += mapped;
      continue;
    }
    const base = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (/^[a-z]$/.test(base)) out += base.toUpperCase();
  }
  return out;
}

/**
 * Gorunen addan 2 harfli on ek: "Yusuf Sari" -> "YS", tek sozcuk "Ayse" -> "AY".
 * E-posta benzeri degerler (`@`) ve harf icermeyen adlar yok sayilir ve `MC`
 * doner; e-posta yerel kismi asla kullanilmaz.
 */
export function referralPrefixFromName(displayName: string | null | undefined): string {
  if (typeof displayName !== "string" || displayName.includes("@")) return FALLBACK_PREFIX;
  const words = displayName
    .split(/\s+/)
    .map(asciiLetters)
    .filter((word) => word.length > 0);
  const first = words[0];
  const last = words[words.length - 1];
  if (first === undefined || last === undefined) return FALLBACK_PREFIX;
  if (words.length >= 2) return `${first.charAt(0)}${last.charAt(0)}`;
  return first.length >= 2 ? first.slice(0, 2) : `${first}X`;
}

export function generatePublicReferralCode(prefix: string): string {
  return `${prefix}-${randomInt(10000, 100000)}`;
}

/**
 * Okunabilir davet kodunu dondurur; yoksa ad on ekiyle uretir ve BIR KEZ
 * kaydeder (ad sonradan degisse de kod degismez). Carpisma benzersiz
 * indeksle yakalanir ve yeni rakamlarla tekrarlanir; kendi on eki dolarsa `MC`.
 */
export async function getOrCreatePublicReferralCode(db: Database, userId: number): Promise<string> {
  let prefix: string | null = null;
  for (let attempt = 0; attempt < PUBLIC_CODE_ATTEMPTS; attempt++) {
    const [current] = await rows<{
      referral_public_code: string | null;
      display_name: string | null;
    }>(db, sql`SELECT referral_public_code, display_name FROM app_user WHERE id = ${userId}`);
    if (!current) throw new Error("kullanici bulunamadi");
    if (current.referral_public_code) return current.referral_public_code;
    prefix ??= referralPrefixFromName(current.display_name);
    const usePrefix = attempt < PUBLIC_CODE_ATTEMPTS / 2 ? prefix : FALLBACK_PREFIX;
    try {
      const [set] = await rows<{ referral_public_code: string }>(
        db,
        sql`
          UPDATE app_user SET referral_public_code = ${generatePublicReferralCode(usePrefix)}
           WHERE id = ${userId} AND referral_public_code IS NULL
          RETURNING referral_public_code
        `,
      );
      if (set) return set.referral_public_code;
    } catch (error) {
      if (uniqueViolationConstraint(error) === null) throw error;
    }
  }
  throw new Error("davet kodu uretilemedi");
}

/** Kodu dondurur; yoksa uretir. Esanli iki cagri ayni kodu gorur. */
export async function getOrCreateReferralCode(db: Database, userId: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [current] = await rows<{ referral_code: string | null }>(
      db,
      sql`SELECT referral_code FROM app_user WHERE id = ${userId}`,
    );
    if (!current) throw new Error("kullanici bulunamadi");
    if (current.referral_code) return current.referral_code;
    try {
      const [set] = await rows<{ referral_code: string }>(
        db,
        sql`
          UPDATE app_user SET referral_code = ${generateReferralCode()}
           WHERE id = ${userId} AND referral_code IS NULL
          RETURNING referral_code
        `,
      );
      if (set) return set.referral_code;
      // Baska bir istek bu arada yazdi: bir sonraki turda okunur.
    } catch (error) {
      // Kod carpismasi (32^8 uzayda nadir): yeni kodla tekrar.
      if (uniqueViolationConstraint(error) === null) throw error;
    }
  }
  throw new Error("davet kodu uretilemedi");
}

export type AttachReferralResult = "attached" | "invalid_code" | "self" | "already_referred";

/**
 * Yeni hesabi davet edene baglar. Cagiran YALNIZCA yeni acilan hesap icin
 * cagirir (`isNewUser`); giris akisini asla bozmamasi icin hata atmaz,
 * sonucu dondurur - beklenmeyen veritabani hatasi yine de iletilir.
 */
export async function attachReferral(
  db: Database,
  input: { inviteeUserId: number; code: string },
): Promise<AttachReferralResult> {
  const code = normalizeReferralCode(input.code);
  if (!code) return "invalid_code";
  const [inviter] = await rows<{ id: number }>(
    db,
    sql`SELECT id FROM app_user WHERE referral_code = ${code} OR referral_public_code = ${code}`,
  );
  if (!inviter) return "invalid_code";
  if (Number(inviter.id) === input.inviteeUserId) return "self";

  const inserted = await db
    .insert(referral)
    .values({ inviterUserId: Number(inviter.id), inviteeUserId: input.inviteeUserId })
    .onConflictDoNothing({ target: referral.inviteeUserId })
    .returning({ id: referral.id });
  return inserted.length > 0 ? "attached" : "already_referred";
}

export interface QualifiedReferral {
  referralId: number;
  inviterUserId: number | null;
}

/**
 * `settleCharge`'in islemi icinde: davet edilen kullanicinin bekleyen daveti
 * varsa nitelenir ve iki taraf odullendirilir. Kilit sirasi kullanici
 * kimligine gore artan: iki davetli ayni anda nitelenirse kilitlenme olmaz.
 */
export async function qualifyReferralInTx(
  tx: Tx,
  input: { inviteeUserId: number; chargeId: string },
): Promise<QualifiedReferral | null> {
  const [qualified] = await rows<{ id: number; inviter_user_id: number | null }>(
    tx,
    sql`
      UPDATE referral
         SET status = 'qualified', qualified_at = now(), qualifying_charge_id = ${input.chargeId}
       WHERE invitee_user_id = ${input.inviteeUserId} AND status = 'pending'
      RETURNING id, inviter_user_id
    `,
  );
  if (!qualified) return null;

  const referralId = Number(qualified.id);
  const inviterUserId =
    qualified.inviter_user_id === null ? null : Number(qualified.inviter_user_id);
  const grants = [
    {
      userId: input.inviteeUserId,
      amount: REWARD_AMOUNTS.referralInvitee,
      reason: "referral_invitee" as const,
      idempotencyKey: `referral:${referralId}:invitee`,
    },
    ...(inviterUserId === null
      ? []
      : [
          {
            userId: inviterUserId,
            amount: REWARD_AMOUNTS.referralInviter,
            reason: "referral_inviter" as const,
            idempotencyKey: `referral:${referralId}:inviter`,
          },
        ]),
  ].sort((a, b) => a.userId - b.userId);

  for (const grant of grants) {
    await grantBonus(tx, { ...grant, referralId });
  }
  return { referralId, inviterUserId };
}

export interface ReferralSummary {
  /** Herkese gorunen okunabilir kod (0051). Eski `referral_code` linkleri de calisir. */
  code: string;
  pending: number;
  qualified: number;
}

/** `/hesap`: kullanicinin davet kodu ve davet ettiklerinin durumu. */
export async function getReferralSummary(db: Database, userId: number): Promise<ReferralSummary> {
  const code = await getOrCreatePublicReferralCode(db, userId);
  const counts = await db
    .select({ status: referral.status, total: count() })
    .from(referral)
    .where(eq(referral.inviterUserId, userId))
    .groupBy(referral.status);
  return {
    code,
    pending: counts.find((row) => row.status === "pending")?.total ?? 0,
    qualified: counts.find((row) => row.status === "qualified")?.total ?? 0,
  };
}
