"use server";

import { UNSUBSCRIBE_PAGE_PATH, unsubscribeByToken } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";

/**
 * Onay düğmesinin POST'u. Oturum gerekmez: yetki e-postadaki tek kullanımlık
 * olmayan, yalnızca iptal yapabilen token'dır. Sonuç sayfasına token
 * taşınmaz (adres çubuğunda, geçmişte ve Referer'da kalmasın).
 */
export async function unsubscribeAction(formData: FormData): Promise<void> {
  const result = await unsubscribeByToken(getDatabase(), formData.get("t"), {
    ip: clientIp(await headers()),
  });
  redirect(`${UNSUBSCRIBE_PAGE_PATH}?durum=${result.status === "invalid" ? "gecersiz" : "tamam"}`);
}
