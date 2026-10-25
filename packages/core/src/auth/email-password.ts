/**
 * E-posta + sifre ile kayit ve giris (karar 0150). Google/Apple/telefon/e-posta
 * baglantisi akislarina dokunmaz; ayni `app_user`/`session` modelini ve
 * `createSessionForUser`'i kullanir.
 *
 * Degismezler:
 * - Sifre ozeti (Argon2id) YALNIZCA e-posta adresinin kontrolu kanitlandiktan
 *   sonra `password_credential`'a yazilir. Kayit aninda `app_user` acilmaz;
 *   bekleyen ozet dogrulama token'inin satirinda tutulur. Dogrulanmamis adres
 *   ile oturum acilamaz ve baska birinin adresi isgal edilemez.
 * - Var olan bir hesabin adresiyle kayit denenirse YENI sifre kabul edilmez
 *   (kayit eden kisi adresin sahibi olmayabilir: sifreyi onceden belirleyip
 *   hesabi ele gecirme). Bunun yerine adrese "hesabin var" e-postasi gider;
 *   sifre ancak adresin sahibinin sifirlama baglantisiyla belirlenir.
 * - Kayit/sifirlama/yeniden gonderim yaniti hesabin varligini belli etmez:
 *   sonuc her durumda "e-posta gonderildi"dir.
 * - Personel (moderator/admin) hesaplari sifreyle girmez; yonetim girisi
 *   Google ile kalir (karar 0056).
 * - Token'lar 256 bit rastgeledir, HMAC-SHA256 ozeti saklanir, amaca ozeldir
 *   (`purpose`), tek kullanimlidir, kisa omurludur.
 * - Sifre degisince/sifirlaninca ilgili oturumlar silinir.
 */
import {
  appUser,
  type Database,
  type EmailCredentialPurpose,
  emailCredentialToken,
  passwordCredential,
  session,
} from "@arilla/db";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { recordSessionEnd } from "../activity/auth-events.ts";
import type { RequestContext } from "../activity/request-context.ts";
import { requireAppUrl } from "../config/app-url.ts";
import { EmailDeliveryError } from "../email/delivery-error.ts";
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidEmailError,
  PasswordPolicyError,
  PrivateRelayEmailError,
} from "./password-errors.ts";
import {
  burnPasswordVerification,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "./password-hash.ts";
import { checkPasswordPolicy } from "./password-policy.ts";
import {
  checkEmailSendRateLimit,
  checkLoginRateLimit,
  checkPasswordChangeRateLimit,
  releaseEmailSendRateLimit,
} from "./password-rate-limit.ts";
import { DEFAULT_REDIRECT_PATH, safeRedirectPath } from "./safe-redirect.ts";
import {
  RESET_PASSWORD_TTL_MINUTES,
  sendCredentialEmail,
  VERIFY_EMAIL_TTL_MINUTES,
} from "./send-credential-email.ts";
import { createSessionForUser } from "./session.ts";
import { generateRawToken, hashToken } from "./token.ts";
import type { SessionUser } from "./types.ts";
import { retryOnUniqueViolation } from "./unique-race.ts";
import {
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
} from "./verify-login-token.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const DISPLAY_NAME_MAX_LENGTH = 80;
/** Bekleyen kaydin "yeniden gonder" ile canlandirilabilecegi en uzun sure. */
const PENDING_REGISTRATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function normalizeCredentialEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidCredentialEmail(email: string): boolean {
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

/** Apple "E-postami Gizle" donusturucu adresi. */
export function isApplePrivateRelayEmail(email: string): boolean {
  return email.endsWith("@privaterelay.appleid.com");
}

function assertUsableEmail(email: string): void {
  if (!isValidCredentialEmail(email)) throw new InvalidEmailError();
}

function cleanDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, DISPLAY_NAME_MAX_LENGTH) : null;
}

/** Personel (moderator/admin) hesaplari sifre akisina girmez (karar 0056, 0150). */
export function isStaffRole(role: string): boolean {
  return role === "moderator" || role === "admin";
}

export function buildVerifyEmailUrl(appUrl: string, rawToken: string, next?: string | null) {
  const url = new URL("/giris/eposta-dogrula", appUrl);
  url.searchParams.set("token", rawToken);
  const safeNext = safeRedirectPath(next);
  if (safeNext !== DEFAULT_REDIRECT_PATH) url.searchParams.set("next", safeNext);
  return url.toString();
}

export function buildResetPasswordUrl(appUrl: string, rawToken: string) {
  const url = new URL("/giris/sifre-sifirla", appUrl);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

/** Ayni adres+amac icin onceki acik token'lari gecersiz kilar, yenisini yazar. */
async function issueToken(
  db: Pick<Database, "transaction">,
  input: {
    purpose: EmailCredentialPurpose;
    email: string;
    ip: string | null;
    pendingPasswordHash?: string | null;
    pendingDisplayName?: string | null;
  },
): Promise<string> {
  const rawToken = generateRawToken();
  const ttlMinutes =
    input.purpose === "verify_email" ? VERIFY_EMAIL_TTL_MINUTES : RESET_PASSWORD_TTL_MINUTES;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(emailCredentialToken)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailCredentialToken.email, input.email),
          eq(emailCredentialToken.purpose, input.purpose),
          isNull(emailCredentialToken.consumedAt),
        ),
      );
    await tx.insert(emailCredentialToken).values({
      purpose: input.purpose,
      email: input.email,
      tokenHash: hashToken(rawToken),
      pendingPasswordHash: input.pendingPasswordHash ?? null,
      pendingDisplayName: input.pendingDisplayName ?? null,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
      requestIp: input.ip,
    });
  });
  return rawToken;
}

async function findUserByEmail(db: Pick<Database, "select">, email: string) {
  const rows = await db
    .select({ id: appUser.id, role: appUser.role })
    .from(appUser)
    .where(eq(appUser.email, email))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Kayit
// ---------------------------------------------------------------------------

export interface RegisterWithPasswordInput {
  email: string;
  password: string;
  displayName?: string | null;
  ip: string | null;
  next?: string | null;
}

/**
 * Sonuc her durumda "dogrulama e-postasi gonderildi" (var olan hesap icin
 * "hesabin var" e-postasi gider). Gonderim hatasi iki dalda da ayni
 * `EmailDeliveryError`'dur; hesabin varligi sizmaz.
 */
export async function registerWithPassword(
  db: Database,
  input: RegisterWithPasswordInput,
): Promise<void> {
  const appUrl = requireAppUrl();
  const email = normalizeCredentialEmail(input.email);
  assertUsableEmail(email);
  if (isApplePrivateRelayEmail(email)) throw new PrivateRelayEmailError();
  const violation = checkPasswordPolicy(input.password, { email });
  if (violation) throw new PasswordPolicyError(violation);

  await checkEmailSendRateLimit("register", { email, ip: input.ip });

  // Iki dalda da ayni maliyet: ozet her zaman hesaplanir.
  const passwordHash = await hashPassword(input.password);
  const existing = await findUserByEmail(db, email);

  try {
    if (existing) {
      // Personelde sifre akisi yok; yine de yanit ve sure ayni kalsin diye e-posta gonderilmez.
      if (!isStaffRole(existing.role)) {
        const rawToken = await issueToken(db, { purpose: "reset_password", email, ip: input.ip });
        await sendCredentialEmail({
          kind: "account_exists",
          email,
          url: buildResetPasswordUrl(appUrl, rawToken),
        });
      }
      return;
    }
    const rawToken = await issueToken(db, {
      purpose: "verify_email",
      email,
      ip: input.ip,
      pendingPasswordHash: passwordHash,
      pendingDisplayName: cleanDisplayName(input.displayName),
    });
    await sendCredentialEmail({
      kind: "verify_email",
      email,
      url: buildVerifyEmailUrl(appUrl, rawToken, input.next),
    });
  } catch (error) {
    // Gonderilemeyen e-posta icin adres hakki geri verilir: "az once gonderdik"
    // yalani olmaz.
    await releaseEmailSendRateLimit("register", email);
    throw error;
  }
}

/** Dogrulama e-postasini yeniden gonderir. Yanit hesap/bekleyen kayit varligini belli etmez. */
export async function resendVerificationEmail(
  db: Database,
  input: { email: string; ip: string | null; next?: string | null },
): Promise<void> {
  const appUrl = requireAppUrl();
  const email = normalizeCredentialEmail(input.email);
  assertUsableEmail(email);
  await checkEmailSendRateLimit("resend", { email, ip: input.ip });

  const pending = await db
    .select({
      passwordHash: emailCredentialToken.pendingPasswordHash,
      displayName: emailCredentialToken.pendingDisplayName,
    })
    .from(emailCredentialToken)
    .where(
      and(
        eq(emailCredentialToken.email, email),
        eq(emailCredentialToken.purpose, "verify_email"),
        isNull(emailCredentialToken.consumedAt),
        gt(emailCredentialToken.createdAt, new Date(Date.now() - PENDING_REGISTRATION_WINDOW_MS)),
      ),
    )
    .orderBy(desc(emailCredentialToken.createdAt))
    .limit(1);
  const row = pending[0];
  // Bekleyen kayit yoksa ya da adres artik bir hesaba aitse sessizce biter.
  if (!row?.passwordHash || (await findUserByEmail(db, email))) return;

  try {
    const rawToken = await issueToken(db, {
      purpose: "verify_email",
      email,
      ip: input.ip,
      pendingPasswordHash: row.passwordHash,
      pendingDisplayName: row.displayName,
    });
    await sendCredentialEmail({
      kind: "verify_email",
      email,
      url: buildVerifyEmailUrl(appUrl, rawToken, input.next),
    });
  } catch (error) {
    await releaseEmailSendRateLimit("resend", email);
    // Hesap/bekleyen kayit varligi sizmasin: gonderim hatasi yalnizca loglanir.
    if (error instanceof EmailDeliveryError) {
      console.error(`[giris] verification email delivery failed: ${error.code}`);
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Token okuma/tuketme
// ---------------------------------------------------------------------------

interface LoadedToken {
  id: number;
  email: string;
  pendingPasswordHash: string | null;
  pendingDisplayName: string | null;
}

async function loadUsableToken(
  db: Pick<Database, "select">,
  rawToken: string,
  purpose: EmailCredentialPurpose,
): Promise<LoadedToken> {
  const rows = await db
    .select()
    .from(emailCredentialToken)
    .where(
      and(
        eq(emailCredentialToken.tokenHash, hashToken(rawToken)),
        eq(emailCredentialToken.purpose, purpose),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new TokenNotFoundError();
  if (row.consumedAt) throw new TokenAlreadyUsedError();
  if (row.expiresAt.getTime() < Date.now()) throw new TokenExpiredError();
  return {
    id: row.id,
    email: row.email,
    pendingPasswordHash: row.pendingPasswordHash,
    pendingDisplayName: row.pendingDisplayName,
  };
}

async function consumeToken(tx: Tx, tokenId: number): Promise<void> {
  const consumed = await tx
    .update(emailCredentialToken)
    .set({ consumedAt: new Date() })
    .where(and(eq(emailCredentialToken.id, tokenId), isNull(emailCredentialToken.consumedAt)))
    .returning({ id: emailCredentialToken.id });
  // Ayni token'i eszamanli tuketmeye calisan ikinci istek.
  if (!consumed[0]) throw new TokenAlreadyUsedError();
}

// ---------------------------------------------------------------------------
// E-posta dogrulama -> hesap + oturum
// ---------------------------------------------------------------------------

export interface ConfirmEmailVerificationInput {
  rawToken: string;
  ip: string | null;
  userAgent: string | null;
  context?: RequestContext;
}

export interface PasswordSignInResult {
  rawSessionToken: string;
  user: SessionUser;
  isNewUser: boolean;
}

/**
 * Dogrulama baglantisinin tuketildigi TEK yer (web'de onay formunun POST'u).
 * Hesap, sifre ozeti ve oturum tek islemde olusur. Adres bu arada baska bir
 * yolla hesaba donusmusse (Google/Apple) sifre baglanmaz ve token tuketilmez
 * (`EmailAlreadyRegisteredError`): ele gecirme yolu acilmaz.
 */
export async function confirmEmailVerification(
  db: Database,
  input: ConfirmEmailVerificationInput,
): Promise<PasswordSignInResult> {
  return retryOnUniqueViolation(() =>
    db.transaction(async (tx) => {
      const token = await loadUsableToken(tx, input.rawToken, "verify_email");
      if (!token.pendingPasswordHash) throw new TokenNotFoundError();
      await consumeToken(tx, token.id);

      if (await findUserByEmail(tx, token.email)) throw new EmailAlreadyRegisteredError();

      const now = new Date();
      const inserted = await tx
        .insert(appUser)
        .values({
          email: token.email,
          emailVerifiedAt: now,
          displayName: token.pendingDisplayName,
          lastSeenAt: now,
        })
        .returning({
          id: appUser.id,
          publicId: appUser.publicId,
          displayName: appUser.displayName,
          avatarUrl: appUser.avatarUrl,
          role: appUser.role,
        });
      const created = inserted[0];
      if (!created) throw new Error("app_user insert bos sonuc dondurdu");
      await tx
        .insert(passwordCredential)
        .values({ userId: created.id, passwordHash: token.pendingPasswordHash });

      const rawSessionToken = await createSessionForUser(tx, {
        userId: created.id,
        role: created.role,
        ip: input.ip,
        userAgent: input.userAgent,
        provider: "email",
        isNewUser: true,
        context: input.context,
      });
      return { rawSessionToken, user: { ...created, email: token.email }, isNewUser: true };
    }),
  );
}

// ---------------------------------------------------------------------------
// Giris
// ---------------------------------------------------------------------------

export interface SignInWithPasswordInput {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  context?: RequestContext;
}

/**
 * Yanlis sifre, var olmayan hesap, sifresiz hesap (orn. yalniz Google) ve
 * personel hesabi AYNI `InvalidCredentialsError` ve ayni maliyetle sonuclanir.
 * Oran siniri sifre denenmeden once uygulanir.
 */
export async function signInWithPassword(
  db: Database,
  input: SignInWithPasswordInput,
): Promise<PasswordSignInResult> {
  const email = normalizeCredentialEmail(input.email);
  if (!isValidCredentialEmail(email) || input.password.length === 0) {
    throw new InvalidCredentialsError();
  }
  await checkLoginRateLimit({ email, ip: input.ip });

  const rows = await db
    .select({
      id: appUser.id,
      publicId: appUser.publicId,
      email: appUser.email,
      displayName: appUser.displayName,
      avatarUrl: appUser.avatarUrl,
      role: appUser.role,
      passwordHash: passwordCredential.passwordHash,
    })
    .from(appUser)
    .innerJoin(passwordCredential, eq(passwordCredential.userId, appUser.id))
    .where(eq(appUser.email, email))
    .limit(1);
  const row = rows[0];

  if (!row) {
    await burnPasswordVerification(input.password);
    throw new InvalidCredentialsError();
  }
  const matches = await verifyPassword(input.password, row.passwordHash);
  if (!matches || isStaffRole(row.role)) throw new InvalidCredentialsError();

  const { passwordHash, ...user } = row;
  const rehashed = passwordNeedsRehash(passwordHash) ? await hashPassword(input.password) : null;

  return db.transaction(async (tx) => {
    const now = new Date();
    if (rehashed) {
      await tx
        .update(passwordCredential)
        .set({ passwordHash: rehashed, updatedAt: now })
        .where(eq(passwordCredential.userId, user.id));
    }
    await tx.update(appUser).set({ lastSeenAt: now }).where(eq(appUser.id, user.id));
    const rawSessionToken = await createSessionForUser(tx, {
      userId: user.id,
      role: user.role,
      ip: input.ip,
      userAgent: input.userAgent,
      provider: "email",
      isNewUser: false,
      context: input.context,
    });
    return { rawSessionToken, user, isNewUser: false };
  });
}

// ---------------------------------------------------------------------------
// Sifremi unuttum / sifirlama
// ---------------------------------------------------------------------------

/**
 * Hesap varsa (ve personel degilse) sifirlama e-postasi gonderir; yoksa hicbir
 * sey yapmaz. Yanit ikisinde de ayni. Gonderim hatasi yalnizca loglanir:
 * hata yalniz var olan hesaplarda olusabilecegi icin disariya verilirse hesap
 * varligi sizardi. (Kalan zamanlama farki oran siniriyla sinirlidir, karar 0150.)
 * Google/Apple'la acilmis hesap da bu yolla sifre belirleyebilir: adresin
 * sahibi oldugunu e-postadaki baglantiyla kanitlar.
 */
export async function requestPasswordReset(
  db: Database,
  input: { email: string; ip: string | null },
): Promise<void> {
  const appUrl = requireAppUrl();
  const email = normalizeCredentialEmail(input.email);
  assertUsableEmail(email);
  await checkEmailSendRateLimit("reset", { email, ip: input.ip });

  const user = await findUserByEmail(db, email);
  if (!user || isStaffRole(user.role)) return;

  try {
    const rawToken = await issueToken(db, { purpose: "reset_password", email, ip: input.ip });
    await sendCredentialEmail({
      kind: "reset_password",
      email,
      url: buildResetPasswordUrl(appUrl, rawToken),
    });
  } catch (error) {
    await releaseEmailSendRateLimit("reset", email);
    if (error instanceof EmailDeliveryError) {
      console.error(`[giris] reset email delivery failed: ${error.code}`);
      return;
    }
    throw error;
  }
}

/** Sifirlama sayfasinin GET'inde baglanti gecerli mi diye yan etkisiz bakar. */
export async function checkResetTokenUsable(db: Database, rawToken: string): Promise<void> {
  await loadUsableToken(db, rawToken, "reset_password");
}

/**
 * Yeni sifreyi belirler, ilgili TUM oturumlari kapatir ve adresin diger acik
 * token'larini gecersiz kilar. Oturum ACILMAZ: kullanici yeni sifresiyle girer.
 * Politika ihlalinde token tuketilmez (kullanici tekrar deneyebilir).
 */
export async function resetPasswordWithToken(
  db: Database,
  input: { rawToken: string; newPassword: string },
): Promise<void> {
  const token = await loadUsableToken(db, input.rawToken, "reset_password");
  const violation = checkPasswordPolicy(input.newPassword, { email: token.email });
  if (violation) throw new PasswordPolicyError(violation);
  const passwordHash = await hashPassword(input.newPassword);

  await db.transaction(async (tx) => {
    await consumeToken(tx, token.id);
    const user = await findUserByEmail(tx, token.email);
    if (!user || isStaffRole(user.role)) throw new TokenNotFoundError();

    const now = new Date();
    await tx
      .insert(passwordCredential)
      .values({ userId: user.id, passwordHash, updatedAt: now })
      .onConflictDoUpdate({
        target: passwordCredential.userId,
        set: { passwordHash, updatedAt: now },
      });
    // Adresin sahibi oldugu kanitlandi.
    await tx
      .update(appUser)
      .set({ emailVerifiedAt: sql`COALESCE(${appUser.emailVerifiedAt}, now())` })
      .where(eq(appUser.id, user.id));
    await tx
      .update(emailCredentialToken)
      .set({ consumedAt: now })
      .where(
        and(eq(emailCredentialToken.email, token.email), isNull(emailCredentialToken.consumedAt)),
      );
    await revokeSessions(tx, user.id);
  });
}

async function revokeSessions(tx: Tx, userId: number, keepTokenHash?: string): Promise<number> {
  const deleted = await tx
    .delete(session)
    .where(
      keepTokenHash
        ? and(eq(session.userId, userId), ne(session.tokenHash, keepTokenHash))
        : eq(session.userId, userId),
    )
    .returning({ id: session.id });
  for (const row of deleted) {
    await recordSessionEnd(tx, { userId, sessionId: row.id, kind: "session_revoked" });
  }
  return deleted.length;
}

// ---------------------------------------------------------------------------
// Sifre degistirme (oturum acik)
// ---------------------------------------------------------------------------

export async function hasPasswordCredential(db: Database, userId: number): Promise<boolean> {
  const rows = await db
    .select({ userId: passwordCredential.userId })
    .from(passwordCredential)
    .where(eq(passwordCredential.userId, userId))
    .limit(1);
  return rows.length > 0;
}

/**
 * `userId` ve `currentSessionToken` yalnizca dogrulanmis oturumdan gelmelidir.
 * Mevcut sifre dogrulanir (oran sinirli); basarida bu oturum DISINDAKI tum
 * oturumlar kapanir. Hic sifresi olmayan hesap (yalniz Google/Apple) bu yolu
 * kullanamaz: `requestPasswordReset` ile e-posta uzerinden sifre belirler.
 * Donus: kapatilan oturum sayisi.
 */
export async function changePassword(
  db: Database,
  input: {
    userId: number;
    currentSessionToken: string;
    currentPassword: string;
    newPassword: string;
  },
): Promise<number> {
  await checkPasswordChangeRateLimit(input.userId);

  const rows = await db
    .select({
      passwordHash: passwordCredential.passwordHash,
      email: appUser.email,
      role: appUser.role,
    })
    .from(passwordCredential)
    .innerJoin(appUser, eq(appUser.id, passwordCredential.userId))
    .where(eq(passwordCredential.userId, input.userId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    await burnPasswordVerification(input.currentPassword);
    throw new InvalidCredentialsError();
  }
  if (!(await verifyPassword(input.currentPassword, row.passwordHash)) || isStaffRole(row.role)) {
    throw new InvalidCredentialsError();
  }
  const violation = checkPasswordPolicy(input.newPassword, { email: row.email });
  if (violation) throw new PasswordPolicyError(violation);
  const passwordHash = await hashPassword(input.newPassword);

  return db.transaction(async (tx) => {
    await tx
      .update(passwordCredential)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(passwordCredential.userId, input.userId));
    return revokeSessions(tx, input.userId, hashToken(input.currentSessionToken));
  });
}
