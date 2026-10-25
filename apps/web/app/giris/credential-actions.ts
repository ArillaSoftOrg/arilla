"use server";

import {
  authProviderAvailability,
  confirmEmailVerification,
  EmailAlreadyRegisteredError,
  loginPathWithNext,
  type PasswordSignInResult,
  postAuthRedirect,
  registerWithPassword,
  requestContextFromHeaders,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  safeRedirectPath,
  signInWithPassword,
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { setSessionCookie } from "../lib/session-cookie.ts";
import { syncConsentAfterSignIn } from "./consent-sync.ts";
import { type CredentialFormState, credentialErrorCode } from "./credential-errors.ts";
import { settleReferralAfterSignIn } from "./referral-cookie.ts";

/**
 * E-posta + şifre sunucu eylemleri (karar 0150). Server action olduğu için
 * yalnızca POST ile çağrılır ve Next, Origin'i Host ile karşılaştırır
 * (CSRF). İş kuralı `packages/core/src/auth/email-password.ts`'tedir; burada
 * yalnızca form okuma, çerez ve yönlendirme var. `redirect()` try/catch
 * dışında çağrılır (Next rehberi). Hiçbir yanıt hesabın varlığını belli etmez;
 * şifre ve token loglanmaz.
 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function available(): boolean {
  return authProviderAvailability().email;
}

async function finishSignIn(signedIn: PasswordSignInResult, next: string): Promise<never> {
  await setSessionCookie(signedIn.rawSessionToken);
  await settleReferralAfterSignIn(await cookies(), signedIn);
  await syncConsentAfterSignIn(signedIn.user.id);
  // Ürüne erişemeyen (lansman öncesi normal kullanıcı) girişte başarı ekranına.
  redirect(postAuthRedirect(signedIn.user, next));
}

export async function loginAction(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const email = field(formData, "email").trim().toLowerCase();
  const next = safeRedirectPath(formData.get("next"));
  if (!available()) return { status: "error", code: "unavailable", email };

  const headerStore = await headers();
  let signedIn: PasswordSignInResult;
  try {
    signedIn = await signInWithPassword(getDatabase(), {
      email,
      password: field(formData, "password"),
      ip: clientIp(headerStore),
      userAgent: headerStore.get("user-agent"),
      context: requestContextFromHeaders(headerStore),
    });
  } catch (error) {
    return { status: "error", code: await credentialErrorCode(error), email };
  }
  return finishSignIn(signedIn, next);
}

export async function registerAction(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const email = field(formData, "email").trim().toLowerCase();
  const name = field(formData, "name");
  if (!available()) return { status: "error", code: "unavailable", email, name };

  const headerStore = await headers();
  try {
    await registerWithPassword(getDatabase(), {
      email,
      password: field(formData, "password"),
      displayName: name,
      ip: clientIp(headerStore),
      next: field(formData, "next"),
    });
  } catch (error) {
    return { status: "error", code: await credentialErrorCode(error), email, name };
  }
  return { status: "sent", email, kind: "register" };
}

export async function resendVerificationAction(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const email = field(formData, "email").trim().toLowerCase();
  if (!available()) return { status: "error", code: "unavailable", email };

  const headerStore = await headers();
  try {
    await resendVerificationEmail(getDatabase(), {
      email,
      ip: clientIp(headerStore),
      next: field(formData, "next"),
    });
  } catch (error) {
    return { status: "error", code: await credentialErrorCode(error), email };
  }
  return { status: "sent", email, kind: "resend" };
}

export async function forgotPasswordAction(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const email = field(formData, "email").trim().toLowerCase();
  if (!available()) return { status: "error", code: "unavailable", email };

  const headerStore = await headers();
  try {
    await requestPasswordReset(getDatabase(), { email, ip: clientIp(headerStore) });
  } catch (error) {
    return { status: "error", code: await credentialErrorCode(error), email };
  }
  return { status: "sent", email, kind: "forgot" };
}

export async function resetPasswordAction(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const rawToken = field(formData, "token");
  const password = field(formData, "password");
  if (password !== field(formData, "confirm")) {
    return { status: "error", code: "password_mismatch" };
  }
  try {
    await resetPasswordWithToken(getDatabase(), { rawToken, newPassword: password });
  } catch (error) {
    return { status: "error", code: await credentialErrorCode(error) };
  }
  // Oturum açılmaz: kullanıcı yeni şifresiyle girer; eski oturumlar kapatıldı.
  redirect("/giris/eposta?durum=sifre_degisti");
}

/**
 * Doğrulama bağlantısının tüketildiği TEK yer (onay formunun POST'u). Hesap,
 * şifre kaydı ve oturum tek işlemde açılır.
 */
export async function confirmVerificationAction(formData: FormData): Promise<void> {
  const rawToken = field(formData, "token");
  const next = safeRedirectPath(formData.get("next"));
  if (!rawToken) redirect(loginPathWithNext(next));

  const headerStore = await headers();
  let signedIn: PasswordSignInResult;
  try {
    signedIn = await confirmEmailVerification(getDatabase(), {
      rawToken,
      ip: clientIp(headerStore),
      userAgent: headerStore.get("user-agent"),
      context: requestContextFromHeaders(headerStore),
    });
  } catch (error) {
    let status: "suresi_doldu" | "gecersiz" | "hesap_var";
    if (error instanceof TokenExpiredError) status = "suresi_doldu";
    else if (error instanceof EmailAlreadyRegisteredError) status = "hesap_var";
    else if (error instanceof TokenAlreadyUsedError || error instanceof TokenNotFoundError) {
      status = "gecersiz";
    } else throw error;
    redirect(`/giris/eposta?durum=${status}`);
  }
  await finishSignIn(signedIn, next);
}
