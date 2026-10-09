"use server";

import { InboxValidationError, setInboxMessagePriority, setInboxMessageStatus } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireCapability } from "../../lib/dal.ts";

/**
 * Gelen kutusu triyajı (karar 0086). `messages.triage` (yönetici); taze giriş
 * ve gerekçe İSTENMEZ (kamuya etkisi yok), ama her değişiklik core'da aynı
 * işlemde denetime yazılır. İzinli geçişler ve eşzamanlılık core'da.
 */
export type InboxActionResult = { ok: true; changed: boolean } | { ok: false; message: string };

function done(result: Awaited<ReturnType<typeof setInboxMessageStatus>>): InboxActionResult {
  switch (result.status) {
    case "updated":
      revalidatePath("/yonetim/mesajlar");
      return { ok: true, changed: true };
    case "unchanged":
      return { ok: true, changed: false };
    case "not_found":
      return { ok: false, message: "Mesaj bulunamadı." };
    case "conflict":
      return { ok: false, message: "Mesajın durumu bu arada değişti. Sayfayı yenile." };
  }
}

function failure(error: unknown): InboxActionResult {
  if (error instanceof InboxValidationError) return { ok: false, message: error.message };
  throw error;
}

export async function setMessageStatusAction(input: {
  messageId: number;
  next: string;
  expectedStatus: string;
}): Promise<InboxActionResult> {
  const { actor } = await requireCapability("messages.triage");
  try {
    return done(
      await setInboxMessageStatus(getDatabase(), actor, {
        messageId: input?.messageId,
        next: input?.next,
        expectedStatus: input?.expectedStatus,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function setMessagePriorityAction(input: {
  messageId: number;
  priority: string | null;
}): Promise<InboxActionResult> {
  const { actor } = await requireCapability("messages.triage");
  try {
    return done(
      await setInboxMessagePriority(getDatabase(), actor, {
        messageId: input?.messageId,
        priority: input?.priority ?? null,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
