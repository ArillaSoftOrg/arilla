/**
 * Oturum dogrulama ve sonlandirma. `apps/web/app/lib/dal.ts` buradaki
 * `verifySessionToken`'i cerezden okudugu ham token ile cagirir - Next.js
 * authentication rehberinin DAL deseni, `cookies()` erisimi apps/web'de kalir.
 */

import { appUser, type Database, session } from "@arilla/db";
import { eq } from "drizzle-orm";
import { generateRawToken, hashToken } from "./token.ts";
import type { SessionUser } from "./types.ts";

export async function createSessionForUser(
  db: Pick<Database, "insert">,
  input: { userId: number; ip: string | null; userAgent: string | null },
): Promise<string> {
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

/** Cikis - `apps/web` bu asamada UI'a baglamiyor, E3'un hazirligi. */
export async function deleteSession(db: Database, rawToken: string): Promise<void> {
  await db.delete(session).where(eq(session.tokenHash, hashToken(rawToken)));
}
