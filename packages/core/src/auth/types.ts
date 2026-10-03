/**
 * E1 icin disari acik tipler. `attribution/types.ts` deseniyle ayni: DB satir
 * sekli degil, cagiran kodun gordugu sozlesme.
 */

import type { appUser } from "@arilla/db";
import type { RequestContext } from "../activity/request-context.ts";

export type UserRole = (typeof appUser.$inferSelect)["role"];

export interface RequestLoginLinkInput {
  email: string;
  ip: string | null;
  /** Giris sonrasi donus yolu; `safeRedirectPath` ile suzulur, guvensizse eklenmez. */
  next?: string | null;
}

export interface RequestLoginLinkResult {
  /** UI'a asla dogrudan sizdirilmaz - yalnizca test/log amacli. */
  authTokenId: number;
}

export interface VerifyLoginTokenInput {
  rawToken: string;
  ip: string | null;
  userAgent: string | null;
  /** 0049: kaba istek baglami (cihaz/tarayici/ulke). */
  context?: RequestContext;
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
  displayName: string | null;
  avatarUrl: string | null;
  role: UserRole;
  /**
   * Oturumun açıldığı an. Yalnızca `verifySessionToken` doldurur; yönetimde
   * hassas işlemler taze oturum ister (docs/decisions/0041).
   */
  sessionCreatedAt?: Date;
  /**
   * Bu istekten ONCEKI son kullanım anı. Yalnızca `verifySessionToken`
   * doldurur; yönetim alanı boşta kalma süresini bununla ölçer (P3).
   */
  sessionLastUsedAt?: Date;
}
