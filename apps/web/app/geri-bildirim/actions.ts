"use server";

import { type SubmitFeedbackResult, submitFeedback } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { clientIp } from "../lib/client-ip.ts";
import { verifySession } from "../lib/dal.ts";

export type FeedbackActionResult = SubmitFeedbackResult | { status: "session_expired" };

/**
 * `/geri-bildirim` gonderimi (docs/decisions/0045). Is kurallarinin tamami
 * core'da (`submitFeedback`); burada yalnizca oturum ve IP okunur.
 *
 * - Kullanici yalnizca sunucudaki oturumdan gelir; formdaki hicbir alan
 *   kimlik tasimaz.
 * - `expectedSignedIn`: sayfa girisli cizildiyse istemci `true` gonderir.
 *   Guven degil, yalnizca beklenti: oturum bu arada dustuyse geri bildirim
 *   sessizce anonim yazilmaz, kullaniciya tekrar giris onerilir.
 * - Beklenmeyen hata (orn. oturum sorgusu) kullaniciya sabit bir durum
 *   olarak doner; logda ayrinti, form icerigi ya da e-posta yer almaz.
 */
export async function submitFeedbackAction(
  expectedSignedIn: boolean,
  formData: FormData,
): Promise<FeedbackActionResult> {
  try {
    const user = await verifySession();
    if (expectedSignedIn === true && !user) {
      return { status: "session_expired" };
    }
    return await submitFeedback(getDatabase(), {
      fields: formData.entries(),
      user: user ? { id: user.id, email: user.email } : null,
      ip: clientIp(await headers()),
    });
  } catch {
    console.error("[feedback] unexpected failure");
    return { status: "unavailable" };
  }
}
