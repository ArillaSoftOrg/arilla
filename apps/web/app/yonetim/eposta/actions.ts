"use server";

import { EmailSettingsValidationError, updateEmailSettings } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCapability } from "../../lib/dal.ts";

/**
 * `/yonetim/eposta` (docs/decisions/0222). Yetki iki kez denetlenir (burada ve core'da);
 * her değişiklik core'da aynı işlemde denetim kaydına yazılır.
 *
 * Form onay kutularıyla çalışır, istemci betiği gerekmez: işaretli kutu FormData'da `"on"`
 * gelir, işaretsiz kutu hiç gelmez. Anahtar listesi sabit; formdaki başka alan yok sayılır.
 */
const SWITCH_FIELDS = [
  "teamNotifications",
  "visitorConfirmations",
  "priceAlerts",
  "marketingEmails",
] as const;

export async function saveEmailSettingsAction(formData: FormData): Promise<void> {
  const { actor } = await requireCapability("email.manage");
  const input = Object.fromEntries(SWITCH_FIELDS.map((key) => [key, formData.get(key) === "on"]));
  let target = "/yonetim/eposta?ok=1";
  try {
    await updateEmailSettings(getDatabase(), actor, input);
  } catch (error) {
    if (!(error instanceof EmailSettingsValidationError)) throw error;
    target = `/yonetim/eposta?hata=${encodeURIComponent(error.message)}`;
  }
  revalidatePath("/yonetim/eposta");
  redirect(target);
}
