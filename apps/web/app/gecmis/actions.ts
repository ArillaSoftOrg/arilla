"use server";

import { clearHistory } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireProductUser } from "../lib/dal.ts";

/** docs/pages.md: "silme düğmesi zorunludur ve gerçekten silmelidir." */
export async function clearHistoryAction(): Promise<void> {
  const user = await requireProductUser();
  await clearHistory(getDatabase(), user.id);
  revalidatePath("/gecmis");
}
