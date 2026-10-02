"use server";

import {
  revokeUserSessions,
  SessionRevokeValidationError,
  searchUsers,
  UserLookupInputError,
  type UserSearchRow,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireCapability, requireFreshCapability } from "../../lib/dal.ts";

export type SearchState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "ok"; rows: UserSearchRow[]; page: number; hasNext: boolean };

/**
 * POST ile arama: ad, e-posta ya da telefon adres satırına ve erişim
 * günlüklerine düşmez. Kısmi eşleşme, sayfa başına 20 (core `searchUsers`).
 * Yetki her çağrıda sunucuda; arama denetime yazılır, aranan değer yazılmaz.
 */
export async function searchUsersAction(
  _previous: SearchState,
  formData: FormData,
): Promise<SearchState> {
  const { actor } = await requireCapability("users.read");
  const raw = formData.get("q");
  const page = Number(formData.get("sayfa") ?? 1);
  try {
    const result = await searchUsers(getDatabase(), actor, typeof raw === "string" ? raw : "", {
      page,
    });
    return { status: "ok", rows: result.rows, page: result.page, hasNext: result.hasNext };
  } catch (error) {
    if (error instanceof UserLookupInputError) return { status: "error", message: error.message };
    throw error;
  }
}

export type RevokeSessionsResult =
  | { ok: true; count: number }
  | { ok: false; message: string; reauthHref?: string };

/**
 * Hesabın bütün oturumlarını kapat (karar 0050): ele geçirilmiş hesap
 * şüphesi. Yalnızca `users.sessions.revoke` (yönetici) + taze giriş;
 * gerekçe zorunlu ve denetime yazılır (core `revokeUserSessions`).
 */
export async function revokeUserSessionsAction(input: {
  publicId: string;
  reason: string;
}): Promise<RevokeSessionsResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("users.sessions.revoke");
  if (!fresh) {
    // docs/copy.md `admin.login.reauth`
    return {
      ok: false,
      message: "Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski).",
      reauthHref,
    };
  }
  try {
    const result = await revokeUserSessions(getDatabase(), actor, {
      publicId: input?.publicId,
      reason: input?.reason,
    });
    if (!result.found) return { ok: false, message: "Hesap bulunamadı." };
    revalidatePath("/yonetim/kullanicilar", "layout");
    return { ok: true, count: result.count };
  } catch (error) {
    if (error instanceof SessionRevokeValidationError) return { ok: false, message: error.message };
    throw error;
  }
}
