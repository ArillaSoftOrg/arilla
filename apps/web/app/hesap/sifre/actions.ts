"use server";

import {
  authProviderAvailability,
  changePassword,
  isStaffRole,
  requestPasswordReset,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { type CredentialFormState, credentialErrorCode } from "../../giris/credential-errors.ts";
import { clientIp } from "../../lib/client-ip.ts";
import { requireUser } from "../../lib/dal.ts";
import { readSessionCookie } from "../../lib/session-cookie.ts";

/**
 * Oturum açık kullanıcının şifre eylemleri (karar 0150). Kullanıcı kimliği
 * yalnızca doğrulanmış oturumdan gelir (`requireUser`); formdaki hiçbir alan
 * kimlik belirlemez. Server action: yalnızca POST, Next Origin'i denetler.
 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export type ChangePasswordState = CredentialFormState | { status: "changed"; revoked: number };

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await requireUser();
  const sessionToken = await readSessionCookie();
  const next = field(formData, "password");
  if (!sessionToken || isStaffRole(user.role)) return { status: "error", code: "generic" };
  if (next !== field(formData, "confirm")) {
    return { status: "error", code: "password_mismatch" };
  }

  try {
    const revoked = await changePassword(getDatabase(), {
      userId: user.id,
      currentSessionToken: sessionToken,
      currentPassword: field(formData, "current"),
      newPassword: next,
    });
    return { status: "changed", revoked };
  } catch (error) {
    const code = await credentialErrorCode(error);
    // Mevcut şifre yanlışsa genel "e-posta/şifre hatalı" yerine alana özgü mesaj.
    return { status: "error", code: code === "invalid_credentials" ? "wrong_current" : code };
  }
}

/**
 * Şifresi olmayan hesap (yalnız Google/Apple) kendi adresine şifre belirleme
 * bağlantısı ister; adresin sahibi olduğunu bağlantıyla kanıtlar.
 */
export async function requestPasswordSetupAction(
  _prev: CredentialFormState,
): Promise<CredentialFormState> {
  const user = await requireUser();
  if (!user.email || isStaffRole(user.role) || !authProviderAvailability().email) {
    return { status: "error", code: "unavailable" };
  }
  try {
    await requestPasswordReset(getDatabase(), {
      email: user.email,
      ip: clientIp(await headers()),
    });
  } catch (error) {
    return { status: "error", code: await credentialErrorCode(error), email: user.email };
  }
  return { status: "sent", email: user.email, kind: "forgot" };
}
