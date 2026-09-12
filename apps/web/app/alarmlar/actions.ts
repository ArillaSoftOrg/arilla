"use server";

import { deleteAlert } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "../lib/dal.ts";

export async function deleteAlertAction(alertId: number): Promise<void> {
  const user = await requireUser();
  await deleteAlert(getDatabase(), { userId: user.id, alertId });
  revalidatePath("/alarmlar");
}
