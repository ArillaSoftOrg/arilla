/** Arayuz icin okuma: "Bugun 7/10 · Bonus 14", yenilenme zamani, son hareketler. */
import type {
  AiSearchChargeState,
  AiSearchOperation,
  BonusLedgerReason,
  Database,
} from "@arilla/db";
import { sql } from "drizzle-orm";
import { dailySearchLimit } from "./config.ts";
import { nextResetAt } from "./day.ts";
import { rows } from "./db.ts";

export interface EntitlementStatus {
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  bonus: number;
  /** Hic hak kalmadi mi (gunluk + bonus). */
  exhausted: boolean;
  nextResetAt: Date;
}

export async function getEntitlementStatus(
  db: Database,
  userId: number,
  now: Date = new Date(),
): Promise<EntitlementStatus> {
  const [row] = await rows<{
    daily_limit: number | null;
    used: number | null;
    balance: number | null;
  }>(
    db,
    sql`
      SELECT q.daily_limit, q.used, b.balance
        FROM (SELECT 1) AS one
        LEFT JOIN ai_quota_day q
               ON q.user_id = ${userId}
              AND q.day = ((${now.toISOString()}::timestamptz) AT TIME ZONE 'Europe/Istanbul')::date
        LEFT JOIN bonus_account b ON b.user_id = ${userId}
    `,
  );
  const dailyLimit = row?.daily_limit ?? dailySearchLimit();
  const dailyUsed = row?.used ?? 0;
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const bonus = row?.balance ?? 0;
  return {
    dailyLimit,
    dailyUsed,
    dailyRemaining,
    bonus,
    exhausted: dailyRemaining === 0 && bonus === 0,
    nextResetAt: nextResetAt(now),
  };
}

export type EntitlementHistoryItem =
  | {
      kind: "search";
      at: Date;
      operation: AiSearchOperation;
      state: AiSearchChargeState;
      fromBonus: number;
    }
  | { kind: "bonus"; at: Date; reason: BonusLedgerReason; delta: number };

/**
 * `/hesap` hak gecmisi: son aramalar ve bonus kazanimlari, yeniden eskiye.
 * Harcama/iade defter satirlari aramanin kendisinde gorunur, tekrarlanmaz.
 */
export async function listEntitlementHistory(
  db: Database,
  userId: number,
  limit = 20,
): Promise<EntitlementHistoryItem[]> {
  const [charges, grants] = await Promise.all([
    rows<{
      created_at: string | Date;
      operation: AiSearchOperation;
      state: AiSearchChargeState;
      from_bonus: number;
    }>(
      db,
      sql`
        SELECT created_at, operation, state, from_bonus FROM ai_search_charge
         WHERE user_id = ${userId}
         ORDER BY created_at DESC LIMIT ${limit}
      `,
    ),
    rows<{ created_at: string | Date; reason: BonusLedgerReason; delta: number }>(
      db,
      sql`
        SELECT created_at, reason, delta FROM bonus_ledger
         WHERE user_id = ${userId} AND reason NOT IN ('search_charge', 'search_refund')
         ORDER BY created_at DESC, id DESC LIMIT ${limit}
      `,
    ),
  ]);
  const items: EntitlementHistoryItem[] = [
    ...charges.map((row) => ({
      kind: "search" as const,
      at: new Date(row.created_at),
      operation: row.operation,
      state: row.state,
      fromBonus: row.from_bonus,
    })),
    ...grants.map((row) => ({
      kind: "bonus" as const,
      at: new Date(row.created_at),
      reason: row.reason,
      delta: row.delta,
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
