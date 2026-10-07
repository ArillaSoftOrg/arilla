"use server";

import {
  EarlyAccessCounterValidationError,
  invalidateEarlyAccessProgressCache,
  setOffPlatformCount,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCapability } from "../../lib/dal.ts";

/**
 * `/yonetim/erken-erisim` (docs/decisions/0065). Yetki iki kez denetlenir
 * (burada ve core'da); gerekçe zorunlu, denetim kaydı core'da aynı işlemde.
 */
export async function setOffPlatformCountAction(formData: FormData): Promise<void> {
  const { actor } = await requireCapability("early_access.manage");
  let target = "/yonetim/erken-erisim?ok=1";
  try {
    await setOffPlatformCount(getDatabase(), actor, formData.get("count"), formData.get("reason"));
  } catch (error) {
    if (!(error instanceof EarlyAccessCounterValidationError)) throw error;
    target = `/yonetim/erken-erisim?hata=${encodeURIComponent(error.message)}`;
  }
  await invalidateEarlyAccessProgressCache();
  revalidatePath("/yonetim/erken-erisim");
  redirect(target);
}
