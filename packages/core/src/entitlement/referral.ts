/**
 * Davet (docs/decisions/0046 madde 9).
 *
 * - Kod: `app_user.referral_code`, ilk istendiginde uretilir. 8 karakter,
 *   karistirilabilen harf/rakam yok (I, O, 0, 1).
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

export function generateReferralCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Kullanicinin yazdigi/linkteki kodu kanonik bicime getirir; gecersizse `null`. */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
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
    sql`SELECT id FROM app_user WHERE referral_code = ${code}`,
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
  code: string;
  pending: number;
  qualified: number;
}

/** `/hesap`: kullanicinin davet kodu ve davet ettiklerinin durumu. */
export async function getReferralSummary(db: Database, userId: number): Promise<ReferralSummary> {
  const code = await getOrCreateReferralCode(db, userId);
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
