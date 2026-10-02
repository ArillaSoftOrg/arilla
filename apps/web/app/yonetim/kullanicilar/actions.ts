"use server";

import { searchUsers, UserLookupInputError, type UserSearchRow } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../lib/dal.ts";

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
