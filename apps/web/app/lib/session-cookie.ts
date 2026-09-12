import { cookies } from "next/headers";

/**
 * decision 0006 madde 3: httpOnly, Secure, SameSite=Lax çerez. `theme-
 * actions.ts` ile aynı üslup - ince bir `cookies()` sarmalayıcısı.
 *
 * Çerez adı bilerek `session` - `apps/web/app/git/[offerId]/route.ts`'teki
 * anonim tıklama takip çerezi `session_id` ile karıştırılmasın diye.
 */
const COOKIE_NAME = "session";

export async function setSessionCookie(rawToken: string): Promise<void> {
  const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS ?? 90);
  const store = await cookies();
  store.set(COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionTtlDays * 24 * 60 * 60,
  });
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value;
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
