/**
 * Next.js authentication rehberindeki DAL deseni: `cookies()` erişimi burada
 * kalır, gerçek doğrulama `packages/core`'daki `verifySessionToken`'a delege
 * edilir (CLAUDE.md kural 6 - iş mantığı core'da).
 *
 * `apps/web/proxy.ts` yalnızca iyimser (çerez var mı) kontrol yapar; bu
 * dosyadaki `requireRole` her server action ve sayfada TEKRAR çağrılmalı -
 * Next'in kendi rehberi proxy'nin tek başına yeterli olmadığını söylüyor.
 */
import { type SessionUser, type UserRole, verifySessionToken } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { cache } from "react";
import { readSessionCookie } from "./session-cookie.ts";

export const verifySession = cache(async (): Promise<SessionUser | null> => {
  const rawToken = await readSessionCookie();
  if (!rawToken) return null;
  return verifySessionToken(getDatabase(), rawToken);
});

/** Yetkisizse `/giris`'e yönlendirir (redirect `never` döner, çağıran taraf her zaman kullanıcıyı alır). */
export async function requireRole(roles: readonly UserRole[]): Promise<SessionUser> {
  const user = await verifySession();
  if (!user || !roles.includes(user.role)) {
    redirect("/giris");
  }
  return user;
}

/** `/kaydettiklerim`, `/alarmlar`, `/gecmis` (docs/routes.md "giriş gerekli") - rol farketmez. */
export async function requireUser(): Promise<SessionUser> {
  const user = await verifySession();
  if (!user) {
    redirect("/giris");
  }
  return user;
}
