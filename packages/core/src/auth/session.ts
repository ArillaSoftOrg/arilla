/**
 * Oturum dogrulama ve sonlandirma. `apps/web/app/lib/dal.ts` buradaki
 * `verifySessionToken`'i cerezden okudugu ham token ile cagirir - Next.js
 * authentication rehberinin DAL deseni, `cookies()` erisimi apps/web'de kalir.
 */

import { appUser, type Database, session } from "@arilla/db";
import { eq } from "drizzle-orm";
import { hashToken } from "./token.ts";
import type { SessionUser } from "./types.ts";

export async function verifySessionToken(
  db: Database,
  rawToken: string,
): Promise<SessionUser | null> {
  const tokenHash = hashToken(rawToken);

  const rows = await db
    .select({
      sessionId: session.id,
      expiresAt: session.expiresAt,
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

  return { id: row.userId, publicId: row.publicId, email: row.email, role: row.role };
}

/** Cikis - `apps/web` bu asamada UI'a baglamiyor, E3'un hazirligi. */
export async function deleteSession(db: Database, rawToken: string): Promise<void> {
  await db.delete(session).where(eq(session.tokenHash, hashToken(rawToken)));
}
