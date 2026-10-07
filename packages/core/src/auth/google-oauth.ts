import { appUser, type Database, userIdentity } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "../activity/request-context.ts";
import { createSessionForUser } from "./session.ts";
import type { SessionUser } from "./types.ts";
import { retryOnUniqueViolation } from "./unique-race.ts";

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface SignInWithGoogleInput {
  profile: GoogleProfile;
  ip: string | null;
  userAgent: string | null;
  /** 0049: kaba istek baglami (cihaz/tarayici/ulke); IP ve ham UA yeni tablolara yazilmaz. */
  context?: RequestContext;
}

export interface SignInWithGoogleResult {
  rawSessionToken: string;
  user: SessionUser;
  isNewUser: boolean;
}

export class GoogleEmailNotVerifiedError extends Error {
  constructor() {
    super("google e-postasi dogrulanmamis");
    this.name = "GoogleEmailNotVerifiedError";
  }
}

export async function signInWithGoogle(
  db: Database,
  input: SignInWithGoogleInput,
): Promise<SignInWithGoogleResult> {
  const email = input.profile.email.trim().toLowerCase();
  if (!input.profile.emailVerified) {
    throw new GoogleEmailNotVerifiedError();
  }

  // Esanli ilk giris yarisi (`unique-race.ts`): kaybeden islem bir kez tekrar.
  return retryOnUniqueViolation(() => signInWithGoogleOnce(db, input, email));
}

function signInWithGoogleOnce(
  db: Database,
  input: SignInWithGoogleInput,
  email: string,
): Promise<SignInWithGoogleResult> {
  return db.transaction(async (tx) => {
    const identityRows = await tx
      .select({
        userId: appUser.id,
        publicId: appUser.publicId,
        email: appUser.email,
        displayName: appUser.displayName,
        avatarUrl: appUser.avatarUrl,
        role: appUser.role,
      })
      .from(userIdentity)
      .innerJoin(appUser, eq(appUser.id, userIdentity.userId))
      .where(
        and(
          eq(userIdentity.provider, "google"),
          eq(userIdentity.providerSubject, input.profile.sub),
        ),
      )
      .limit(1);

    const existingIdentity = identityRows[0];
    if (existingIdentity) {
      await tx
        .update(userIdentity)
        .set({
          email,
          emailVerified: input.profile.emailVerified,
          displayName: input.profile.name,
          avatarUrl: input.profile.picture,
          lastSeenAt: new Date(),
        })
        .where(
          and(
            eq(userIdentity.provider, "google"),
            eq(userIdentity.providerSubject, input.profile.sub),
          ),
        );
      await tx
        .update(appUser)
        .set({ lastSeenAt: new Date() })
        .where(eq(appUser.id, existingIdentity.userId));
      const rawSessionToken = await createSessionForUser(tx, {
        userId: existingIdentity.userId,
        role: existingIdentity.role,
        ip: input.ip,
        userAgent: input.userAgent,
        provider: "google",
        isNewUser: false,
        context: input.context,
      });
      return {
        rawSessionToken,
        user: {
          id: existingIdentity.userId,
          publicId: existingIdentity.publicId,
          email: existingIdentity.email,
          displayName: existingIdentity.displayName,
          avatarUrl: existingIdentity.avatarUrl,
          role: existingIdentity.role,
        },
        isNewUser: false,
      };
    }

    const usersByEmail = await tx
      .select({
        id: appUser.id,
        publicId: appUser.publicId,
        displayName: appUser.displayName,
        avatarUrl: appUser.avatarUrl,
        role: appUser.role,
      })
      .from(appUser)
      .where(eq(appUser.email, email))
      .limit(1);

    const isNewUser = !usersByEmail[0];
    let user: SessionUser;
    if (usersByEmail[0]) {
      await tx
        .update(appUser)
        .set({
          emailVerifiedAt: input.profile.emailVerified ? new Date() : undefined,
          displayName: input.profile.name,
          avatarUrl: input.profile.picture,
          lastSeenAt: new Date(),
        })
        .where(eq(appUser.id, usersByEmail[0].id));
      user = {
        ...usersByEmail[0],
        email,
        displayName: input.profile.name,
        avatarUrl: input.profile.picture,
      };
    } else {
      const insertedUsers = await tx
        .insert(appUser)
        .values({
          email,
          emailVerifiedAt: input.profile.emailVerified ? new Date() : undefined,
          displayName: input.profile.name,
          avatarUrl: input.profile.picture,
          lastSeenAt: new Date(),
        })
        .returning({
          id: appUser.id,
          publicId: appUser.publicId,
          displayName: appUser.displayName,
          avatarUrl: appUser.avatarUrl,
          role: appUser.role,
        });
      const insertedUser = insertedUsers[0];
      if (!insertedUser) {
        throw new Error("app_user insert bos sonuc dondurdu");
      }
      user = { ...insertedUser, email };
    }

    await tx.insert(userIdentity).values({
      userId: user.id,
      provider: "google",
      providerSubject: input.profile.sub,
      email,
      emailVerified: input.profile.emailVerified,
      displayName: input.profile.name,
      avatarUrl: input.profile.picture,
      lastSeenAt: new Date(),
    });

    const rawSessionToken = await createSessionForUser(tx, {
      userId: user.id,
      role: user.role,
      ip: input.ip,
      userAgent: input.userAgent,
      provider: "google",
      isNewUser,
      context: input.context,
    });

    return { rawSessionToken, user, isNewUser };
  });
}
