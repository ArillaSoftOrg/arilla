"use server";

import { type LexiconKind, upsertLexiconEntry } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/dal.ts";

export interface SaveLexiconInput {
  id?: number;
  kind: LexiconKind;
  surface: string;
  normalized: string;
  weight: number;
}

/** pages.md: "Yeni satır eklendiğinde ayrıştırıcı anında etkilenir." */
export async function saveLexiconEntryAction(input: SaveLexiconInput): Promise<void> {
  await requireRole(["moderator", "admin"]);
  await upsertLexiconEntry(getDatabase(), input);
  revalidatePath("/yonetim/sozluk");
}
