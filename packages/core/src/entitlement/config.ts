/**
 * Arama hakki sabitleri (docs/decisions/0047). Maliyet, limit ve odul
 * degerleri YALNIZCA burada tanimlanir; istemciden gelen hicbir sayiya
 * guvenilmez.
 */
import type { AiSearchOperation } from "@arilla/db";
import { QUOTA_POLICY } from "../quota/policy.ts";

/**
 * Islem basina hak maliyeti. Ikisi de ayni havuzdan (`search_rights`) 1 hak;
 * link aramasi kapaliyken (`LINK_SEARCH_PUBLIC`) hic cagrilmaz.
 */
export const AI_OPERATION_COST: Readonly<Record<AiSearchOperation, number>> = {
  visual_search: 1,
  link_search: 1,
};

/** Hak havuzunun saat/gun/hafta/ay limitleri (`quota/policy.ts`). */
export const SEARCH_RIGHTS_LIMITS = QUOTA_POLICY.search_rights;

export const DEFAULT_DAILY_SEARCH_LIMIT = SEARCH_RIGHTS_LIMITS.day;

/** Bonus bakiyesinin tavani. Odul bu tavana kirpilir; iade kirpilmaz. */
export const BONUS_BALANCE_MAX = 100;

export const REWARD_AMOUNTS = {
  referralInviter: 10,
  referralInvitee: 5,
  feedbackFirst: 3,
} as const;

/**
 * Kullanici basina pahali arama ISTEK hizi (Redis, sabit pencere): kotuye
 * kullanim siniri, reddedilen denemeleri de sayar. Urun kotasindan
 * (`SEARCH_RIGHTS_LIMITS`, yalnizca harcanan hak) ayridir ve gevsetilmez.
 */
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
