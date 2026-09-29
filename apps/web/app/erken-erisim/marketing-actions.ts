"use server";

import { EARLY_ACCESS_PATH, recordMarketingEmailConsent } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { requireUser } from "../lib/dal.ts";

/**
 * Erken erişim ekranındaki isteğe bağlı pazarlama rızası (docs/decisions/0046).
 * Kutu işaretsiz gelir; işaretlenmeden gönderilirse hiçbir olay yazılmaz ve
 * erken erişim kaydı etkilenmez. Kimlik oturumdan, adres ve metin sürümü
 * sunucudan gelir.
 */
export async function saveEarlyAccessMarketingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (formData.get("marketing_email") === "on" && user.email) {
    await recordMarketingEmailConsent(getDatabase(), {
      userId: user.id,
      granted: true,
      source: "early_access",
      ip: clientIp(await headers()),
    });
  }
  redirect(EARLY_ACCESS_PATH);
}
