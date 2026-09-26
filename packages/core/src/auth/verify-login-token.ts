/**
 * decision 0006: token dogrulama tek islemde tuketilir (race'e karsi
 * `WHERE consumed_at IS NULL` kosullu UPDATE). Basariliysa e-postaya gore
 * `app_user` bul-ya-da-olustur (hesap burada acilir, `request-login-link`
 * asamasinda degil) ve yeni bir `session` satiri yazilir.
 *
 * Hata durumlari ayri siniflarla ayrisir cunku `apps/web` her biri icin
 * farkli copy anahtari gosterir (`auth.token_expired` / `auth.token_used`).
 */

import { appUser, authToken, type Database } from "@arilla/db";
import { and, eq, isNull } from "drizzle-orm";
import { createSessionForUser } from "./session.ts";
import { hashToken } from "./token.ts";
import type { SessionUser, VerifyLoginTokenInput, VerifyLoginTokenResult } from "./types.ts";

export class TokenNotFoundError extends Error {
  constructor() {
    super("giris baglantisi gecersiz");
    this.name = "TokenNotFoundError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("giris baglantisinin suresi dolmus");
    this.name = "TokenExpiredError";
  }
}

export class TokenAlreadyUsedError extends Error {
  constructor() {
    super("giris baglantisi zaten kullanilmis");
    this.name = "TokenAlreadyUsedError";
  }
}

export async function verifyLoginToken(
  db: Database,
  input: VerifyLoginTokenInput,
): Promise<VerifyLoginTokenResult> {
  const tokenHash = hashToken(input.rawToken);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(authToken)
      .where(eq(authToken.tokenHash, tokenHash))
      .limit(1);
    const tokenRow = rows[0];
    if (!tokenRow) {
      throw new TokenNotFoundError();
    }
    if (tokenRow.consumedAt) {
      throw new TokenAlreadyUsedError();
    }
    if (tokenRow.expiresAt.getTime() < Date.now()) {
      throw new TokenExpiredError();
    }

    const consumed = await tx
      .update(authToken)
      .set({ consumedAt: new Date() })
      .where(and(eq(authToken.id, tokenRow.id), isNull(authToken.consumedAt)))
      .returning({ id: authToken.id });
    if (!consumed[0]) {
      // Ayni token'i eszamanli tuketmeye calisan ikinci istek.
      throw new TokenAlreadyUsedError();
    }

    const existingUsers = await tx
      .select({ id: appUser.id, publicId: appUser.publicId, role: appUser.role })
      .from(appUser)
      .where(eq(appUser.email, tokenRow.email))
      .limit(1);

    const isNewUser = !existingUsers[0];
    let user: SessionUser;
    if (existingUsers[0]) {
      await tx
        .update(appUser)
        .set({ emailVerifiedAt: new Date(), lastSeenAt: new Date() })
        .where(eq(appUser.id, existingUsers[0].id));
      user = { ...existingUsers[0], email: tokenRow.email };
    } else {
      const insertedUsers = await tx
        .insert(appUser)
        .values({ email: tokenRow.email, emailVerifiedAt: new Date(), lastSeenAt: new Date() })
        .returning({ id: appUser.id, publicId: appUser.publicId, role: appUser.role });
      const insertedUser = insertedUsers[0];
      if (!insertedUser) {
        throw new Error("app_user insert bos sonuc dondurdu");
      }
      user = { ...insertedUser, email: tokenRow.email };
    }

    const rawSessionToken = await createSessionForUser(tx, {
      userId: user.id,
      userAgent: input.userAgent,
      ip: input.ip,
    });

    return { rawSessionToken, user, isNewUser };
  });
}
