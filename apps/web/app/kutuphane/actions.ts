"use server";

import { clearLibrary, removeLibraryItem } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireProductUser } from "../lib/dal.ts";

/** Kütüphane (karar 0217): kullanıcı yalnızca KENDİ satırını siler (`user_id` oturumdan). */
export async function removeLibraryItemAction(productId: number): Promise<void> {
  const user = await requireProductUser();
  if (!Number.isInteger(productId)) return;
  await removeLibraryItem(getDatabase(), user.id, productId);
}

export async function clearLibraryAction(): Promise<void> {
  const user = await requireProductUser();
  await clearLibrary(getDatabase(), user.id);
}
