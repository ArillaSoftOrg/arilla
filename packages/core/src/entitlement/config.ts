/**
 * Arama hakki sabitleri (docs/decisions/0047). Maliyet, limit ve odul
 * degerleri YALNIZCA burada tanimlanir; istemciden gelen hicbir sayiya
 * guvenilmez.
 */
import type { AiSearchOperation } from "@arilla/db";

/** Islem basina hak maliyeti. V1'de ikisi de 1; ileride islem bazinda degisebilir. */
export const AI_OPERATION_COST: Readonly<Record<AiSearchOperation, number>> = {
  visual_search: 1,
  link_search: 1,
};

export const DEFAULT_DAILY_SEARCH_LIMIT = 10;

/** Bonus bakiyesinin tavani. Odul bu tavana kirpilir; iade kirpilmaz. */
export const BONUS_BALANCE_MAX = 100;

export const REWARD_AMOUNTS = {
  referralInviter: 10,
  referralInvitee: 5,
  feedbackFirst: 3,
} as const;

/** Kullanici basina pahali arama istek hizi (Redis, sabit pencere). */
export const AI_SEARCH_RATE_LIMITS = [
  { name: "min", windowSeconds: 60, max: 3 },
  { name: "hour", windowSeconds: 60 * 60, max: 10 },
] as const;

export const ENTITLEMENT_TIME_ZONE = "Europe/Istanbul";

/**
 * Gunluk hak. `AI_SEARCH_DAILY_LIMIT` pozitif tamsayi degilse varsayilan.
 * Deger gun icinde degisirse o gunun zaten acilmis satiri etkilenmez
 * (`ai_quota_day.daily_limit` anlik goruntudur).
 */
export function dailySearchLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_SEARCH_DAILY_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_SEARCH_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_SEARCH_LIMIT;
}
