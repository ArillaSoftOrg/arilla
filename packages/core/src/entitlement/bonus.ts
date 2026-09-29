/**
 * Bonus bakiyesine her POZITIF degisikligin tek yazma yolu: davet, ilk geri
 * bildirim, ileride yonetici/kampanya. Cagiranin islemi icinde calisir.
 *
 * Tam bir kez: bakiye satiri `FOR UPDATE` ile kilitlendikten SONRA defterde
 * ayni `idempotency_key` aranir. READ COMMITTED'da her ifade yeni bir anlik
 * goruntu alir; esanli ikinci islem kilidi bekler, sonra birincinin yazdigi
 * satiri gorur ve hicbir sey yazmaz. `bonus_ledger_idempotency_key_unique`
 * son savunma hattidir.
 */
import type { BonusLedgerReason } from "@arilla/db";
import { sql } from "drizzle-orm";
import { BONUS_BALANCE_MAX, REWARD_AMOUNTS } from "./config.ts";
import { rows, type Tx } from "./db.ts";
import { cappedCredit } from "./split.ts";

export type GrantReason = Exclude<BonusLedgerReason, "search_charge" | "search_refund">;

export interface GrantBonusInput {
  userId: number;
  amount: number;
  reason: GrantReason;
  idempotencyKey: string;
  referralId?: number | null;
  actorUserId?: number | null;
}

export type GrantBonusResult =
  | { status: "granted"; credited: number; balanceAfter: number }
  /** Tavandaydi; defter satiri yazilmadi (CHECK delta <> 0). */
  | { status: "capped"; credited: 0; balanceAfter: number }
  | { status: "duplicate" };

/** Bakiye satirini yoksa acar ve kilitler; bakiyeyi dondurur. */
export async function lockBonusAccount(tx: Tx, userId: number): Promise<number> {
  await tx.execute(sql`
    INSERT INTO bonus_account (user_id) VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `);
  const [row] = await rows<{ balance: number }>(
    tx,
    sql`SELECT balance FROM bonus_account WHERE user_id = ${userId} FOR UPDATE`,
  );
  if (!row) throw new Error("bonus_account satiri kilitlenemedi");
  return row.balance;
}

export async function grantBonus(tx: Tx, input: GrantBonusInput): Promise<GrantBonusResult> {
  const balance = await lockBonusAccount(tx, input.userId);

  const [existing] = await rows<{ id: number }>(
    tx,
    sql`SELECT id FROM bonus_ledger WHERE idempotency_key = ${input.idempotencyKey}`,
  );
  if (existing) return { status: "duplicate" };

  const credited = cappedCredit({ amount: input.amount, balance, max: BONUS_BALANCE_MAX });
  if (credited === 0) return { status: "capped", credited: 0, balanceAfter: balance };

  const [updated] = await rows<{ balance: number }>(
    tx,
    sql`
      UPDATE bonus_account
         SET balance = balance + ${credited}, updated_at = now()
       WHERE user_id = ${input.userId}
      RETURNING balance
    `,
  );
  if (!updated) throw new Error("bonus_account guncellenemedi");

  await tx.execute(sql`
    INSERT INTO bonus_ledger
      (user_id, delta, requested, balance_after, reason, idempotency_key, referral_id, actor_user_id)
    VALUES
      (${input.userId}, ${credited}, ${input.amount}, ${updated.balance}, ${input.reason},
       ${input.idempotencyKey}, ${input.referralId ?? null}, ${input.actorUserId ?? null})
  `);
  return { status: "granted", credited, balanceAfter: updated.balance };
}

/**
 * Ilk geri bildirim odulu (+3, kullanici basina bir kez). Geri bildirim
 * INSERT'u ile ayni islemde cagrilmak uzere; geri bildirim sistemi (0045)
 * ana dala girdiginde `submitFeedback` buna baglanir.
 */
export function grantFirstFeedbackReward(tx: Tx, userId: number): Promise<GrantBonusResult> {
  return grantBonus(tx, {
    userId,
    amount: REWARD_AMOUNTS.feedbackFirst,
    reason: "feedback_first",
    idempotencyKey: `feedback_first:${userId}`,
  });
}
