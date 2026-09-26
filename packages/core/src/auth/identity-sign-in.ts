/**
 * Saglayici kimligiyle giris (Apple, telefon). `google-oauth.ts` ile ayni
 * model: kimlik `user_identity (provider, provider_subject)` ile bulunur,
 * yoksa kullanici bulunur/acilir ve kimlik baglanir; sonunda mevcut
 * `createSessionForUser`. OAuth access/refresh token'lari saklanmaz.
 *
 * Tekrar giriste kullanici YALNIZCA saglayici kimligiyle bulunur: Apple
 * e-postayi yalnizca ilk giriste dondurur, sonrakilerde `email` bos gelir.
 */
import { appUser, type Database, type IdentityProvider, userIdentity } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import { createSessionForUser } from "./session.ts";
import type { SessionUser } from "./types.ts";

export interface SignInWithIdentityInput {
  provider: Exclude<IdentityProvider, "google">;
  subject: string;
  /** Saglayicinin dogruladigi e-posta; yoksa `null`. */
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface SignInWithIdentityResult {
  rawSessionToken: string;
  user: SessionUser;
  isNewUser: boolean;
}

export async function signInWithIdentity(
  db: Database,
  input: SignInWithIdentityInput,
): Promise<SignInWithIdentityResult> {
  const email = input.email?.trim().toLowerCase() || null;
  const now = new Date();

  return db.transaction(async (tx) => {
    const identityRows = await tx
      .select({
        userId: appUser.id,
        publicId: appUser.publicId,
        email: appUser.email,
        role: appUser.role,
      })
      .from(userIdentity)
      .innerJoin(appUser, eq(appUser.id, userIdentity.userId))
      .where(
        and(
          eq(userIdentity.provider, input.provider),
          eq(userIdentity.providerSubject, input.subject),
        ),
      )
      .limit(1);

    const existing = identityRows[0];
    if (existing) {
      // E-posta bu giriste gelmediyse eskisi korunur (Apple sonraki girislerde
      // e-posta dondurmez); gelen bos deger kayitli degeri silmez.
      await tx
        .update(userIdentity)
        .set({
          ...(email ? { email, emailVerified: input.emailVerified } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          lastSeenAt: now,
        })
        .where(
          and(
            eq(userIdentity.provider, input.provider),
            eq(userIdentity.providerSubject, input.subject),
          ),
        );
      await tx.update(appUser).set({ lastSeenAt: now }).where(eq(appUser.id, existing.userId));
      const rawSessionToken = await createSessionForUser(tx, {
        userId: existing.userId,
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        rawSessionToken,
        user: {
          id: existing.userId,
          publicId: existing.publicId,
          email: existing.email,
          role: existing.role,
        },
        isNewUser: false,
      };
    }

    // Yeni kimlik. Saglayicinin DOGRULADIGI e-posta mevcut bir hesaba aitse
    // o hesaba baglanir (Google ile ayni kural); dogrulanmamis e-posta ile
    // baglama yapilmaz - baskasinin hesabina giris yolu olurdu.
    const linkEmail = email && input.emailVerified ? email : null;
    const usersByEmail = linkEmail
      ? await tx
          .select({ id: appUser.id, publicId: appUser.publicId, role: appUser.role })
          .from(appUser)
          .where(eq(appUser.email, linkEmail))
          .limit(1)
      : [];

    let user: SessionUser;
    const matched = usersByEmail[0];
    if (matched) {
      await tx.update(appUser).set({ lastSeenAt: now }).where(eq(appUser.id, matched.id));
      user = { ...matched, email: linkEmail };
    } else {
      const inserted = await tx
        .insert(appUser)
        .values({
          email: linkEmail,
          emailVerifiedAt: linkEmail ? now : undefined,
          displayName: input.displayName,
          lastSeenAt: now,
        })
        .returning({ id: appUser.id, publicId: appUser.publicId, role: appUser.role });
      const created = inserted[0];
      if (!created) {
        throw new Error("app_user insert bos sonuc dondurdu");
      }
      user = { ...created, email: linkEmail };
    }

    await tx.insert(userIdentity).values({
      userId: user.id,
      provider: input.provider,
      providerSubject: input.subject,
      email,
      emailVerified: input.emailVerified,
      displayName: input.displayName,
      lastSeenAt: now,
    });

    const rawSessionToken = await createSessionForUser(tx, {
      userId: user.id,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { rawSessionToken, user, isNewUser: !matched };
  });
}
