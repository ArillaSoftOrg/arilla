"use server";

import { EARLY_ACCESS_PATH, ensureEarlyAccess } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { requireUser } from "../lib/dal.ts";

/**
 * Listeye elle katılma: P2'den önce açılmış bir oturumla gelen (henüz
 * yeniden giriş yapmamış) kullanıcı için. Girişteki kayıtla aynı idempotent
 * yol; `userId` yalnızca oturumdan gelir.
 */
export async function joinEarlyAccessAction(): Promise<void> {
  const user = await requireUser();
  await ensureEarlyAccess(getDatabase(), user.id);
  redirect(EARLY_ACCESS_PATH);
}
