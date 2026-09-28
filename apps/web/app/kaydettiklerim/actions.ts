"use server";

import { removeSavedItem } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireProductUser } from "../lib/dal.ts";

export async function removeSavedItemAction(productId: number): Promise<void> {
  const user = await requireProductUser();
  await removeSavedItem(getDatabase(), { userId: user.id, productId });
  revalidatePath("/kaydettiklerim");
}
