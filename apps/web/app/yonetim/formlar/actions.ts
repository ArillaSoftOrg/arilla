"use server";

import { createForm, FormValidationError, setFormStatus, updateForm } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireCapability } from "../../lib/dal.ts";

/**
 * `/yonetim/formlar` (docs/decisions/0058). Ince istemci: dogrulama, yetki
 * (ikinci kez) ve denetim kaydi core'da (`packages/core/src/forms`). Her
 * action `forms.manage`'i kendisi ister.
 */

export type FormActionResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

function failure(error: unknown): { ok: false; message: string } {
  if (error instanceof FormValidationError) return { ok: false, message: error.message };
  throw error;
}

function refresh(): void {
  revalidatePath("/yonetim/formlar", "layout");
}

export async function createFormAction(input: unknown): Promise<FormActionResult<{ id: number }>> {
  const { actor } = await requireCapability("forms.manage");
  try {
    const created = await createForm(getDatabase(), actor, input);
    refresh();
    return { ok: true, id: created.id };
  } catch (error) {
    return failure(error);
  }
}

export async function updateFormAction(
  id: number,
  input: unknown,
  expectedUpdatedAt: number,
): Promise<FormActionResult> {
  const { actor } = await requireCapability("forms.manage");
  try {
    const result = await updateForm(getDatabase(), actor, id, input, expectedUpdatedAt);
    if (result.status === "not_found") return { ok: false, message: "Form bulunamadı." };
    if (result.status === "conflict") {
      return {
        ok: false,
        message: "Form başka bir yerde değişti. Sayfayı yenileyip tekrar dene.",
      };
    }
    refresh();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function setFormStatusAction(
  id: number,
  next: "published" | "closed",
): Promise<FormActionResult> {
  const { actor } = await requireCapability("forms.manage");
  if (next !== "published" && next !== "closed") return { ok: false, message: "Geçersiz durum." };
  try {
    const result = await setFormStatus(getDatabase(), actor, id, next);
    if (result.status === "not_found") return { ok: false, message: "Form bulunamadı." };
    refresh();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
