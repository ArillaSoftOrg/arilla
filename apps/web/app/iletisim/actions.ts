"use server";

import {
  notifyFormReceived,
  type SubmitContactResult,
  submitContact,
  validateContact,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { after } from "next/server";
import { clientIp } from "../lib/client-ip.ts";
import { verifySession } from "../lib/dal.ts";
import { CONTACT_CATEGORY_LABELS } from "./contact-copy.ts";

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
 * - E-posta bildirimi (karar 0222) kayıttan SONRA, yanıttan sonra (`after`) denenir; hatası
 *   formu etkilemez. Hangi e-postanın gideceğine yönetimdeki anahtarlar karar verir.
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
    // `entries()` tek kullanımlık; gönderim ve bildirim aynı diziyi okur.
    const fields = Array.from(formData.entries());
    const db = getDatabase();
    const result = await submitContact(db, {
      fields,
      userId: user?.id ?? null,
      ip: clientIp(await headers()),
    });
    if (result.status === "ok") {
      const validated = validateContact(fields);
      if (validated.ok) {
        const { category, subject, email } = validated.value;
        after(() =>
          notifyFormReceived(db, {
            kind: "contact",
            categoryLabel: CONTACT_CATEGORY_LABELS[category],
            title: subject,
            visitorEmail: email,
          }),
        );
      }
    }
    return result;
  } catch {
    console.error("[contact] unexpected failure");
    return { status: "unavailable" };
  }
}
