"use server";

import {
  notifyFormReceived,
  type SubmitFeedbackResult,
  submitFeedback,
  validateFeedback,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { after } from "next/server";
import { clientIp } from "../lib/client-ip.ts";
import { verifySession } from "../lib/dal.ts";
import { FEEDBACK_CATEGORY_LABELS } from "./feedback-copy.ts";

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
 * - E-posta bildirimi (karar 0222) kayittan SONRA, yanittan sonra (`after`) denenir; hatasi
 *   formu etkilemez. Hangi e-postanin gidecegine yonetimdeki anahtarlar karar verir.
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
    // `entries()` tek kullanimlik; gonderim ve bildirim ayni diziyi okur.
    const fields = Array.from(formData.entries());
    const db = getDatabase();
    const result = await submitFeedback(db, {
      fields,
      user: user ? { id: user.id, email: user.email } : null,
      ip: clientIp(await headers()),
    });
    if (result.status === "ok") {
      const validated = validateFeedback(fields, { authenticated: user !== null });
      if (validated.ok) {
        const { category, title, email } = validated.value;
        after(() =>
          notifyFormReceived(db, {
            kind: "feedback",
            categoryLabel: FEEDBACK_CATEGORY_LABELS[category],
            title,
            // Girisli kullanicida adres oturumdaki hesaptan gelir (`submitFeedback` ile ayni kural).
            visitorEmail: user ? user.email : email,
          }),
        );
      }
    }
    return result;
  } catch {
    console.error("[feedback] unexpected failure");
    return { status: "unavailable" };
  }
}
