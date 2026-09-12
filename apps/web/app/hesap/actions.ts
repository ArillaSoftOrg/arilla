"use server";

import type { ConsentKind } from "@arilla/core";
import { clearHistory, deleteAccount, setConsent } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { requireUser } from "../lib/dal.ts";
import { clearSessionCookie } from "../lib/session-cookie.ts";

export async function updateConsentAction(kind: ConsentKind, granted: boolean): Promise<void> {
  const user = await requireUser();
  const ip = clientIp((await headers()).get("x-forwarded-for"));
  await setConsent(getDatabase(), { userId: user.id, kind, granted, ip });
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
export async function deleteAccountAction(): Promise<void> {
  const user = await requireUser();
  await deleteAccount(getDatabase(), user.id);
  await clearSessionCookie();
  redirect("/");
}
