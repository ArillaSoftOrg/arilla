"use server";

import { lookupUser, UserLookupInputError } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { requireCapability } from "../../lib/dal.ts";

export interface LookupState {
  message: string | null;
}

/**
 * POST ile arama: e-posta/telefon adres satırına ve erişim günlüklerine
 * düşmez. Bulunursa ayrıntıya (public id ile) yönlendirir. Arama denetime
 * yazılır; aranan değer yazılmaz (core `lookupUser`).
 */
export async function lookupUserAction(
  _previous: LookupState,
  formData: FormData,
): Promise<LookupState> {
  const { actor } = await requireCapability("users.read");
  const raw = formData.get("kimlik");
  let publicId: string | null;
  try {
    ({ publicId } = await lookupUser(getDatabase(), actor, typeof raw === "string" ? raw : ""));
  } catch (error) {
    if (error instanceof UserLookupInputError) return { message: error.message };
    throw error;
  }
  if (!publicId) return { message: "Bu bilgiyle eşleşen hesap yok." };
  redirect(`/yonetim/kullanicilar/${publicId}`);
}
