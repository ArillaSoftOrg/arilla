/**
 * Oturum dogrulama ve sonlandirma. `apps/web/app/lib/dal.ts` buradaki
 * `verifySessionToken`'i cerezden okudugu ham token ile cagirir - Next.js
 * authentication rehberinin DAL deseni, `cookies()` erisimi apps/web'de kalir.
 */

import { appUser, type Database, session } from "@arilla/db";
import { eq } from "drizzle-orm";
import { ensureEarlyAccess } from "../access/early-access.ts";
import { canAccessProduct } from "../access/product-access.ts";
import { generateRawToken, hashToken } from "./token.ts";
import type { SessionUser, UserRole } from "./types.ts";

/**
 * Dort giris yolunun (e-posta, Google, Apple, telefon) ortak son adimi.
 * Urune erisemeyen kullanici (lansman oncesi normal kullanici) ayni
 * transaction'da erken erisim listesine yazilir; tekrar giriste satir
 * zaten vardir, yeni satir olusmaz (`ensureEarlyAccess`).
 */
export async function createSessionForUser(
  db: Pick<Database, "insert">,
  input: { userId: number; role: UserRole; ip: string | null; userAgent: string | null },
): Promise<string> {
  if (!canAccessProduct({ role: input.role })) {
    await ensureEarlyAccess(db, input.userId);
  }

  const rawSessionToken = generateRawToken();
  const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS ?? 90);
  const sessionExpiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);

  await db.insert(session).values({
    userId: input.userId,
    tokenHash: hashToken(rawSessionToken),
    userAgent: input.userAgent,
    ip: input.ip,
    expiresAt: sessionExpiresAt,
  });

  return rawSessionToken;
}

export async function verifySessionToken(
  db: Database,
  rawToken: string,
): Promise<SessionUser | null> {
  const tokenHash = hashToken(rawToken);

  const rows = await db
    .select({
      sessionId: session.id,
      expiresAt: session.expiresAt,
      sessionCreatedAt: session.createdAt,
      userId: appUser.id,
      publicId: appUser.publicId,
      email: appUser.email,
      role: appUser.role,
    })
    .from(session)
    .innerJoin(appUser, eq(appUser.id, session.userId))
    .where(eq(session.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) {
    return null;
  }

  await db.update(session).set({ lastUsedAt: new Date() }).where(eq(session.id, row.sessionId));

  return {
    id: row.userId,
    publicId: row.publicId,
    email: row.email,
    role: row.role,
    sessionCreatedAt: row.sessionCreatedAt,
  };
}

/** Cikis: yalnizca bu cihazin oturumu silinir (`apps/web/app/cikis-actions.ts`). */
export async function deleteSession(db: Database, rawToken: string): Promise<void> {
  await db.delete(session).where(eq(session.tokenHash, hashToken(rawToken)));
}

/**
 * Tum cihazlardan cikis: kullanicinin butun oturumlari silinir. Silinen
 * oturum sayisini dondurur. `userId` yalnizca dogrulanmis oturumdan gelmelidir.
 */
export async function deleteAllSessionsForUser(db: Database, userId: number): Promise<number> {
  const deleted = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return deleted.length;
}
