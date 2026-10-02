/**
 * Oturum dogrulama ve sonlandirma. `apps/web/app/lib/dal.ts` buradaki
 * `verifySessionToken`'i cerezden okudugu ham token ile cagirir - Next.js
 * authentication rehberinin DAL deseni, `cookies()` erisimi apps/web'de kalir.
 *
 * 0049: giris/cikis gecmisi (`auth_event`) ve kullanici ozeti burada, oturum
 * yazimiyla AYNI islemde uretilir. Yeni tablolara IP ve ham user agent
 * yazilmaz; `session` satiri mevcut alanlarini (oturum omru boyunca) korur.
 */

import { type AuthEventProvider, appUser, type Database, session } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import { ensureEarlyAccess } from "../access/early-access.ts";
import { shouldJoinEarlyAccess } from "../access/product-access.ts";
import { recordSessionEnd, recordSignIn, type SessionEndKind } from "../activity/auth-events.ts";
import { EMPTY_REQUEST_CONTEXT, type RequestContext } from "../activity/request-context.ts";
import { touchLastActive } from "../activity/summary.ts";
import { generateRawToken, hashToken } from "./token.ts";
import type { SessionUser, UserRole } from "./types.ts";

export interface CreateSessionInput {
  userId: number;
  role: UserRole;
  ip: string | null;
  userAgent: string | null;
  /** 0049: giris yontemi (`auth_event.provider`). */
  provider: AuthEventProvider;
  /** 0049: hesap bu islemde mi acildi (`sign_up` olayi). */
  isNewUser: boolean;
  /** 0049: kaba istek baglami; verilmezse bos. */
  context?: RequestContext;
}

/**
 * Dort giris yolunun (e-posta, Google, Apple, telefon) ortak son adimi.
 * Urune erisemeyen kullanici (lansman oncesi normal kullanici) ayni
 * transaction'da erken erisim listesine yazilir; tekrar giriste satir
 * zaten vardir, yeni satir olusmaz (`ensureEarlyAccess`).
 */
export async function createSessionForUser(
  db: Pick<Database, "insert" | "execute">,
  input: CreateSessionInput,
): Promise<string> {
  if (shouldJoinEarlyAccess({ role: input.role })) {
    await ensureEarlyAccess(db, input.userId);
  }

  const context = input.context ?? EMPTY_REQUEST_CONTEXT;
  const rawSessionToken = generateRawToken();
  const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS ?? 90);
  const sessionExpiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);

  const inserted = await db
    .insert(session)
    .values({
      userId: input.userId,
      tokenHash: hashToken(rawSessionToken),
      userAgent: input.userAgent,
      ip: input.ip,
      expiresAt: sessionExpiresAt,
      deviceClass: context.deviceClass,
      browserFamily: context.browserFamily,
      countryCode: context.countryCode,
    })
    .returning({ id: session.id });
  const sessionId = inserted[0]?.id;
  if (!sessionId) throw new Error("oturum olusturulamadi");

  await recordSignIn(db, {
    userId: input.userId,
    provider: input.provider,
    isNewUser: input.isNewUser,
    sessionId,
    context,
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
      sessionLastUsedAt: session.lastUsedAt,
      userId: appUser.id,
      publicId: appUser.publicId,
      email: appUser.email,
      displayName: appUser.displayName,
      avatarUrl: appUser.avatarUrl,
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

  const now = new Date();
  await db.update(session).set({ lastUsedAt: now }).where(eq(session.id, row.sessionId));
  // 0049: "son aktif" en fazla 15 dakikada bir yazilir; bu oturumun onceki
  // kullanimi yeniyse sorgu bile atilmaz.
  await touchLastActive(db, { userId: row.userId, previousUse: row.sessionLastUsedAt, now });

  return {
    id: row.userId,
    publicId: row.publicId,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    sessionCreatedAt: row.sessionCreatedAt,
    // Guncellemeden ONCEKI deger: yonetim bosta kalma kontrolu bunu kullanir.
    sessionLastUsedAt: row.sessionLastUsedAt,
  };
}

/**
 * Cikis: yalnizca bu cihazin oturumu silinir (`apps/web/app/cikis-actions.ts`).
 * `kind`: kullanicinin kendi cikisi `sign_out`; yonetim oturum politikasinin
 * sonlandirmasi `session_revoked` (`apps/web/app/lib/dal.ts`). Olay oturum
 * silmeyle ayni islemde yazilir; oturum yoksa (zaten silinmis) olay da yok.
 */
export async function deleteSession(
  db: Database,
  rawToken: string,
  kind: SessionEndKind = "sign_out",
): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(session)
      .where(eq(session.tokenHash, hashToken(rawToken)))
      .returning({ id: session.id, userId: session.userId });
    const row = deleted[0];
    if (row) {
      await recordSessionEnd(tx, { userId: row.userId, sessionId: row.id, kind });
    }
  });
}

/**
 * Tum cihazlardan cikis: kullanicinin butun oturumlari silinir. Silinen
 * oturum sayisini dondurur. `userId` yalnizca dogrulanmis oturumdan gelmelidir.
 * Her silinen oturum icin `session_revoked` yazilir.
 */
export async function deleteAllSessionsForUser(db: Database, userId: number): Promise<number> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(session)
      .where(and(eq(session.userId, userId)))
      .returning({ id: session.id });
    for (const row of deleted) {
      await recordSessionEnd(tx, { userId, sessionId: row.id, kind: "session_revoked" });
    }
    return deleted.length;
  });
}
