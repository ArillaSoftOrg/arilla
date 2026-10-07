"use server";

import {
  type ChatInputRequest,
  canAccessProduct,
  createConversation,
  getChatInterpreter,
  isChatDiscoveryEnabled,
  isUuid,
  processPendingTurn,
  submitUserMessage,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { verifySession } from "../lib/dal.ts";

/**
 * Konusmali kesif sunucu eylemleri (docs/decisions/0074). Hepsi KENDI oturum ve
 * ozellik denetimini yapar: proxy ya da sayfa tek basina yetmez, eylemler dogrudan
 * cagrilabilir. Is mantigi `packages/core/src/chat` icindedir; burada yalnizca
 * girdi dogrulama ve yanit sekli vardir. Yanitlar yalnizca sabit durum kodlari
 * tasir: mesaj metni, model yaniti ya da hata ayrintisi istemciye donmez.
 */

/** Kutudaki metni `/ara`ya cevirir: sohbet kapaliysa/yapilamiyorsa eski davranis. */
function plainSearchHref(text: string): string {
  return text ? `/ara?${new URLSearchParams({ q: text }).toString()}` : "/ara";
}

/** Ana sayfa kutusu: sohbet olusturur, ilk mesaji kaydeder, `/sohbet/[id]`ye yonlendirir. */
export async function startConversationAction(formData: FormData): Promise<void> {
  const raw = formData.get("q");
  const text = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  if (!text) redirect("/ara");

  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    redirect(plainSearchHref(text));
  }

  const created = await createConversation(getDatabase(), { userId: user.id, message: text });
  // Saatlik tavan ya da gecersiz girdi: kullanici yine de arayabilir (yapay zekasiz yol).
  if (created.status !== "created") redirect(plainSearchHref(text));
  redirect(`/sohbet/${created.conversationId}`);
}

export type SendMessageStatus =
  | "queued"
  | "duplicate"
  | "busy"
  | "rate_limited"
  | "conversation_full"
  | "invalid_input"
  | "invalid_option"
  | "not_found"
  | "unavailable";

/** Istemciden gelen her sey `unknown` sayilir. */
function parseRequest(raw: unknown): ChatInputRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "text" && typeof value.text === "string") {
    return { kind: "text", text: value.text };
  }
  if (
    value.kind === "option" &&
    typeof value.questionId === "string" &&
    typeof value.value === "string"
  ) {
    return { kind: "option", questionId: value.questionId, value: value.value };
  }
  if (value.kind === "skip" && typeof value.questionId === "string") {
    return { kind: "skip", questionId: value.questionId };
  }
  return null;
}

/** Kullanici mesajini kaydeder (model cagrisi yok). */
export async function sendMessageAction(
  conversationId: string,
  request: unknown,
  requestKey: string,
): Promise<{ status: SendMessageStatus }> {
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { status: "unavailable" };
  }
  const parsed = parseRequest(request);
  if (!parsed || typeof conversationId !== "string" || !isUuid(conversationId)) {
    return { status: "invalid_input" };
  }
  const result = await submitUserMessage(getDatabase(), {
    userId: user.id,
    conversationId,
    request: parsed,
    requestKey: typeof requestKey === "string" ? requestKey : undefined,
  });
  return { status: result.status === "queued" ? "queued" : result.status };
}

export type RunTurnStatus =
  | "answered"
  | "busy"
  | "idle"
  | "not_found"
  | "provider_error"
  | "unavailable";

/**
 * Cevaplanmamis son mesaji yorumlar. Tekrar-guvenlidir: ayni anda ikinci cagri
 * `busy`, cevap yazildiktan sonra `idle` doner; istemci bu yuzden serbestce
 * yeniden deneyebilir.
 */
export async function runTurnAction(conversationId: string): Promise<{ status: RunTurnStatus }> {
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { status: "unavailable" };
  }
  if (typeof conversationId !== "string" || !isUuid(conversationId)) {
    return { status: "not_found" };
  }
  let interpreter: ReturnType<typeof getChatInterpreter>;
  try {
    interpreter = getChatInterpreter();
  } catch {
    // Anahtar tanimsiz: yapilandirma hatasi, kullaniciya "tekrar dene" gosterilir.
    return { status: "provider_error" };
  }
  const result = await processPendingTurn(getDatabase(), {
    userId: user.id,
    conversationId,
    interpreter,
  });
  return { status: result.status };
}
