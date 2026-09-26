"use server";

import {
  deleteLexiconEntry,
  type LexiconKind,
  LexiconValidationError,
  upsertLexiconEntry,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireCapability } from "../../lib/dal.ts";

export interface SaveLexiconInput {
  id?: number;
  kind: LexiconKind;
  surface: string;
  normalized: string;
  weight: number;
}

export type LexiconActionResult = { ok: true } | { ok: false; message: string };

const NOT_FOUND = "Satır bulunamadı; başka bir yerde silinmiş olabilir. Sayfayı yenile.";

/** Unique ihlali (aynı tür + yüzey başka bir satırda var) kullanıcıya anlaşılır döner. */
function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/**
 * pages.md: "Yeni satır eklendiğinde ayrıştırıcı anında etkilenir." Girdi core'da
 * doğrulanır (`validateLexiconInput`); değişiklik denetim kaydına yazılır.
 */
export async function saveLexiconEntryAction(
  input: SaveLexiconInput,
): Promise<LexiconActionResult> {
  const { actor } = await requireCapability("dictionary.write");
  try {
    const result = await upsertLexiconEntry(getDatabase(), actor, input);
    if (!result.found) return { ok: false, message: NOT_FOUND };
  } catch (error) {
    if (error instanceof LexiconValidationError) return { ok: false, message: error.message };
    if (isUniqueViolation(error)) {
      return { ok: false, message: "Bu tür ve yüzeyle başka bir satır zaten var." };
    }
    throw error;
  }
  revalidatePath("/yonetim/sozluk");
  return { ok: true };
}

export async function deleteLexiconEntryAction(id: number): Promise<LexiconActionResult> {
  const { actor } = await requireCapability("dictionary.write");
  try {
    const result = await deleteLexiconEntry(getDatabase(), actor, id);
    if (!result.found) return { ok: false, message: NOT_FOUND };
  } catch (error) {
    if (error instanceof LexiconValidationError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath("/yonetim/sozluk");
  return { ok: true };
}
