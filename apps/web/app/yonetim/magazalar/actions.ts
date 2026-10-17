"use server";

import { MerchantValidationError, setMerchantActive } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireFreshCapability } from "../../lib/dal.ts";

export interface SetMerchantActiveActionInput {
  merchantId: number;
  active: boolean;
  reason: string;
  confirmSlug: string;
}

export type MerchantActionResult =
  | { ok: true; changed: boolean }
  | { ok: false; message: string; reauthHref?: string };

/**
 * Yalnızca `merchant.manage` (yönetici) + taze giriş (son 1 saat, docs/decisions/0044). Doğrulama, onay adı ve
 * denetim kaydı core'da (`setMerchantActive`); burası ince istemci.
 */
export async function setMerchantActiveAction(
  input: SetMerchantActiveActionInput,
): Promise<MerchantActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("merchant.manage");
  if (!fresh) {
    // docs/copy.md `admin.merchants.stale_session`; bağlantı `/yonetim/giris?next=...`.
    return {
      ok: false,
      message: "Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski).",
      reauthHref,
    };
  }
  try {
    const result = await setMerchantActive(getDatabase(), actor, {
      merchantId: input?.merchantId,
      active: input?.active,
      reason: input?.reason,
      confirmSlug: input?.confirmSlug,
    });
    if (!result.found) return { ok: false, message: "Mağaza bulunamadı." };
    revalidatePath("/yonetim/magazalar", "layout");
    return { ok: true, changed: result.changed };
  } catch (error) {
    if (error instanceof MerchantValidationError) return { ok: false, message: error.message };
    throw error;
  }
}
