/**
 * E1 icin disari acik tipler. `attribution/types.ts` deseniyle ayni: DB satir
 * sekli degil, cagiran kodun gordugu sozlesme.
 */
import type { appUser } from "@arilla/db";

export type UserRole = (typeof appUser.$inferSelect)["role"];

export interface RequestLoginLinkInput {
  email: string;
  ip: string | null;
}

export interface RequestLoginLinkResult {
  /** UI'a asla dogrudan sizdirilmaz - yalnizca test/log amacli. */
  authTokenId: number;
}

export interface VerifyLoginTokenInput {
  rawToken: string;
  ip: string | null;
  userAgent: string | null;
}

export interface VerifyLoginTokenResult {
  rawSessionToken: string;
  user: SessionUser;
  isNewUser: boolean;
}

export interface SessionUser {
  id: number;
  publicId: string;
  /** 0025: telefonla ya da e-postasiz Apple ile giren kullanicida NULL. */
  email: string | null;
  role: UserRole;
}
