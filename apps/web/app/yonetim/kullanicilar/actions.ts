"use server";

import {
  CONTACT_FIELDS,
  type ContactField,
  revealUserContact,
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

export type RevealState =
  | { status: "ok"; value: string | null }
  | { status: "reauth"; href: string }
  | { status: "not_found" };

/**
 * Tıkla-göster (karar 0049 §2): tek hesabın tam e-postası ya da telefonu.
 * Yetenek `users.contact.reveal` ve son 1 saat içinde giriş gerekir; taze
 * değilse değer DÖNMEZ, yeniden giriş bağlantısı döner. Core da tazeliği
 * ayrıca ister. Gösterim denetime yazılır (alan adı; değer asla).
 *
 * Değer yalnızca bu yanıtta döner: adres satırına, önbelleğe ya da istemci
 * deposuna yazılmaz; sayfa yenilenince yeniden maskelenir.
 */
export async function revealContactAction(
  publicId: string,
  field: ContactField,
): Promise<RevealState> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("users.contact.reveal");
  if (!fresh) return { status: "reauth", href: reauthHref };
  if (typeof publicId !== "string" || !CONTACT_FIELDS.includes(field)) {
    return { status: "not_found" };
  }
  const result = await revealUserContact(getDatabase(), actor, publicId, field, { fresh });
  return result ? { status: "ok", value: result.value } : { status: "not_found" };
}
