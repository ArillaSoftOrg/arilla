"use server";

import type { ConsentKind } from "@arilla/core";
import {
  clearHistory,
  deleteAccount,
  revokeOwnSessions,
  StaffAccountDeletionError,
  setConsent,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { requireUser } from "../lib/dal.ts";
import { clearSessionCookie } from "../lib/session-cookie.ts";

export async function updateConsentAction(kind: ConsentKind, granted: boolean): Promise<void> {
  const user = await requireUser();
  const ip = clientIp(await headers());
  // `kind`/`granted` istemciden gelir; core çalışma zamanında doğrular.
  await setConsent(getDatabase(), {
    userId: user.id,
    kind,
    granted,
    ip,
    source: "account_settings",
  });
  revalidatePath("/hesap");
}

/** docs/pages.md "/hesap": "gezinme geçmişini sil" - `/gecmis`'in aynı çekirdek fonksiyonu, ayrı bir sayfadan. */
export async function clearHistoryAction(): Promise<void> {
  const user = await requireUser();
  await clearHistory(getDatabase(), user.id);
  revalidatePath("/hesap");
  revalidatePath("/gecmis");
}

/**
 * docs/pages.md: "Onay adımı vardır ama geri alınamaz olduğu açıkça
 * yazılır." Onay istemci tarafında (bkz. delete-account-button-client.tsx);
 * bu action geri dönüşü olmayan asıl işlemi yapar.
 */
export type DeleteAccountResult = { ok: false; message: string };

export async function deleteAccountAction(): Promise<DeleteAccountResult> {
  const user = await requireUser();
  try {
    await deleteAccount(getDatabase(), user.id);
  } catch (error) {
    // Karar 0050: yetkili hesap önce rolünü bıraktırır (docs/copy.md
    // `account.delete_staff_blocked`). Hiçbir şey silinmedi.
    if (error instanceof StaffAccountDeletionError) {
      return {
        ok: false,
        message:
          "Yönetim yetkisi olan bir hesap silinemez. Önce yetkinin kaldırılması için ekiple iletişime geç.",
      };
    }
    throw error;
  }
  await clearSessionCookie();
  redirect("/");
}

/**
 * "Tüm cihazlardan çıkış" (karar 0050): bu cihaz dahil bütün oturumlar
 * sunucuda silinir. Şüpheli giriş sonrası kullanıcının kendi acil
 * düğmesi. Server action: yalnızca POST, Origin denetimi Next'te.
 */
export async function logoutAllDevicesAction(): Promise<void> {
  const user = await requireUser();
  await revokeOwnSessions(getDatabase(), user);
  await clearSessionCookie();
  redirect("/giris");
}
