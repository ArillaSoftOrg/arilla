"use server";

import { type SubmitContactResult, submitContact } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { clientIp } from "../lib/client-ip.ts";
import { verifySession } from "../lib/dal.ts";

export type ContactActionResult = SubmitContactResult | { status: "session_expired" };

/**
 * `/iletisim` gönderimi (docs/decisions/0061). İş kurallarının tamamı
 * core'da (`submitContact`); burada yalnızca oturum ve IP okunur. Geri
 * bildirim eylemiyle (`geri-bildirim/actions.ts`) aynı desen:
 *
 * - Hesap yalnızca sunucudaki oturumdan; formdaki hiçbir alan kimlik taşımaz.
 * - `expectedSignedIn`: sayfa girişli çizildiyse ve oturum bu arada düştüyse
 *   mesaj sessizce anonim yazılmaz, tekrar giriş önerilir.
 * - Beklenmeyen hata sabit bir durum olarak döner; logda form içeriği, ad ya
 *   da e-posta yer almaz.
 */
export async function submitContactAction(
  expectedSignedIn: boolean,
  formData: FormData,
): Promise<ContactActionResult> {
  try {
    const user = await verifySession();
    if (expectedSignedIn === true && !user) {
      return { status: "session_expired" };
    }
    return await submitContact(getDatabase(), {
      fields: formData.entries(),
      userId: user?.id ?? null,
      ip: clientIp(await headers()),
    });
  } catch {
    console.error("[contact] unexpected failure");
    return { status: "unavailable" };
  }
}
