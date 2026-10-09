/** Arayuz icin okuma: "Bugun kalan 27/30 · Bonus 14", yenilenme zamani, son hareketler. */
import type {
  AiSearchChargeState,
  AiSearchOperation,
  BonusLedgerReason,
  Database,
} from "@arilla/db";
import { sql } from "drizzle-orm";
import type { QuotaWindow } from "../quota/policy.ts";
import { quotaPeriod } from "../quota/windows.ts";
import { readPeriodUsage } from "./charge.ts";
import { dailySearchLimit, SEARCH_RIGHTS_LIMITS } from "./config.ts";
import { nextResetAt } from "./day.ts";
import { type Executor, rows } from "./db.ts";

export interface WindowStatus {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: Date;
}

export interface EntitlementStatus {
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  bonus: number;
  /** Hic hak kalmadi mi (donem hakki + bonus) ya da saatlik sinir mi doldu. */
  exhausted: boolean;
  nextResetAt: Date;
  /** Dort pencerenin her biri (`quota/policy.ts`, `search_rights`). */
  windows: Readonly<Record<QuotaWindow, WindowStatus>>;
  /**
   * Gun/hafta/ay icinde kalani en az olan (esitlikte en gec yenilenen):
   * kullaniciya tek sayi olarak gosterilen pencere. Bonus bunlari asar.
   */
  limitingWindow: "day" | "week" | "month";
  /** Gun/hafta/ay kalanlarinin kucugu. */
  periodRemaining: number;
}

function windowStatus(limit: number, used: number, window: QuotaWindow, now: Date): WindowStatus {
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: quotaPeriod(window, now).end,
  };
}

export async function getEntitlementStatus(
  db: Executor,
  userId: number,
  now: Date = new Date(),
): Promise<EntitlementStatus> {
  const [[row], usage] = await Promise.all([
    rows<{
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
    ),
    readPeriodUsage(db, userId, now),
  ]);
  const dailyLimit = row?.daily_limit ?? dailySearchLimit();
  const dailyUsed = row?.used ?? 0;
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const bonus = row?.balance ?? 0;
  const windows = {
    hour: windowStatus(SEARCH_RIGHTS_LIMITS.hour, usage.hour, "hour", now),
    day: windowStatus(dailyLimit, dailyUsed, "day", now),
    week: windowStatus(SEARCH_RIGHTS_LIMITS.week, usage.week, "week", now),
    month: windowStatus(SEARCH_RIGHTS_LIMITS.month, usage.month, "month", now),
  };
  // Esitlikte en gec yenilenen: "bu ay kalan 0" "bugun kalan 0"dan daha dogru bilgi.
  const limitingWindow = (["month", "week", "day"] as const).reduce((best, window) =>
    windows[window].remaining < windows[best].remaining ? window : best,
  );
  const periodRemaining = windows[limitingWindow].remaining;
  return {
    dailyLimit,
    dailyUsed,
    dailyRemaining,
    bonus,
    exhausted: (periodRemaining === 0 && bonus === 0) || windows.hour.remaining === 0,
    nextResetAt: nextResetAt(now),
    windows,
    limitingWindow,
    periodRemaining,
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
