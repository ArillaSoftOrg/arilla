"use server";

import {
  type AssistantPreview,
  type ChatInputRequest,
  canAccessProduct,
  consumeChatFeedbackQuota,
  createChatTimer,
  createConversation,
  getChatInterpreter,
  getChatLinkView,
  getTurnStatus,
  ImageRejectedError,
  isChatDiscoveryEnabled,
  isChatImageEnabled,
  isChatLinkEnabled,
  isRedisUnavailableError,
  isUuid,
  isValidRequestKey,
  loadConversation,
  logChatTimings,
  preprocessImage,
  processPendingTurn,
  processPendingTurnDetailed,
  setResultFeedback,
  submitUserMessage,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { after } from "next/server";
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

/**
 * Ilk turu yanit gittikten sonra baslatir (`after()`); `processPendingTurn`in kirasi
 * es zamanli ikinci Gemini cagrisini engeller. Kurulamazsa (anahtar yok, `after`
 * yok) sessizce birakilir: istemci kurtarma yolu (`runTurnAction`) turu baslatir.
 */
function scheduleInitialTurn(
  db: ReturnType<typeof getDatabase>,
  userId: number,
  conversationId: string,
): void {
  try {
    const interpreter = getChatInterpreter();
    after(async () => {
      // Asla firlatmaz; hata olursa kira birakilir ve kurtarma yolu calisir.
      await processPendingTurn(db, { userId, conversationId, interpreter });
    });
  } catch {
    // Kurtarma yolu devralir.
  }
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

  const db = getDatabase();
  const created = await createConversation(db, { userId: user.id, message: text });
  // Saatlik tavan ya da gecersiz girdi: kullanici yine de arayabilir (yapay zekasiz yol).
  if (created.status !== "created") redirect(plainSearchHref(text));
  scheduleInitialTurn(db, user.id, created.conversationId);
  redirect(`/sohbet/${created.conversationId}`);
}

/** `ara/gorsel/actions.ts` ve `next.config.ts` (serverActions.bodySizeLimit) ile ayni sinir. */
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ImageChatResult =
  | { status: "created"; href: string }
  | {
      status:
        | "login_required"
        | "unavailable"
        | "invalid_input"
        | "invalid_type"
        | "too_large"
        | "unprocessable"
        | "rate_limited"
        | "error";
    };

/**
 * Ana sayfa kutusu, fotograf + metin (karar 0078): sohbeti, gorsel eki ve ilk
 * kullanici mesajini TEK islemde olusturur; ilk turu (Gemini, gorselle birlikte)
 * yanit gittikten sonra `after()` ile baslatir. Metin bos olabilir. Gorsel burada
 * dogrulanir ve on islenir (`preprocessImage`: decode, <=512 px, EXIF'siz); ham dosya
 * saklanmaz. Hicbir hata mesaji/yanit icerigi istemciye donmez, yalnizca durum kodu.
 */
export async function startConversationWithImageAction(
  formData: FormData,
): Promise<ImageChatResult> {
  const user = await verifySession();
  if (!user) return { status: "login_required" };
  if (!isChatDiscoveryEnabled() || !isChatImageEnabled() || !canAccessProduct(user)) {
    return { status: "unavailable" };
  }
  const requestKey = formData.get("requestKey");
  if (!isValidRequestKey(requestKey)) return { status: "invalid_input" };
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { status: "invalid_input" };
  if (!IMAGE_MIME_TYPES.has(file.type)) return { status: "invalid_type" };
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) return { status: "too_large" };
  const rawText = formData.get("q");
  const text = typeof rawText === "string" ? rawText.trim().slice(0, 500) : "";

  let prepared: Awaited<ReturnType<typeof preprocessImage>>;
  try {
    prepared = await preprocessImage(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof ImageRejectedError) return { status: "unprocessable" };
    return { status: "error" };
  }

  const db = getDatabase();
  let created: Awaited<ReturnType<typeof createConversation>>;
  try {
    created = await createConversation(db, {
      userId: user.id,
      message: text,
      requestKey,
      attachment: {
        bytes: prepared.bytes,
        mimeType: prepared.mimeType,
        width: prepared.width,
        height: prepared.height,
      },
    });
  } catch {
    return { status: "error" };
  }
  if (created.status === "rate_limited") return { status: "rate_limited" };
  if (created.status !== "created") return { status: "invalid_input" };
  scheduleInitialTurn(db, user.id, created.conversationId);
  return { status: "created", href: `/sohbet/${created.conversationId}` };
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
 * Cevaplanmamis son mesaji yorumlar (kurtarma yolu: normal yolda ilk tur
 * `startChatBootstrapAction`ın `after()` isi ile baslar). Tekrar-guvenlidir:
 * ayni anda ikinci cagri `busy`, cevap yazildiktan sonra `idle` doner.
 * `preview`: yazilan cevabin kisa on izlemesi; kalici kayit sunucudadir.
 */
export async function runTurnAction(
  conversationId: string,
): Promise<{ status: RunTurnStatus; preview?: AssistantPreview }> {
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
  const { result, preview } = await processPendingTurnDetailed(getDatabase(), {
    userId: user.id,
    conversationId,
    interpreter,
  });
  return preview ? { status: result.status, preview } : { status: result.status };
}

export type TurnWaitState = "answered" | "in_flight" | "pending" | "not_found" | "unavailable";

/** Hafif durum sorgusu (sahiplik sorguda): istemci `after()` turunu bu eylemle bekler. */
export async function getTurnStatusAction(
  conversationId: string,
): Promise<{ state: TurnWaitState; preview?: AssistantPreview }> {
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { state: "unavailable" };
  }
  if (typeof conversationId !== "string" || !isUuid(conversationId)) {
    return { state: "not_found" };
  }
  const status = await getTurnStatus(getDatabase(), { userId: user.id, conversationId });
  return status.state === "answered"
    ? { state: "answered", preview: status.preview }
    : { state: status.state };
}

export type NewTabChatResult =
  /** Sohbet olustu; yeni sekme `/sohbet/[id]`ye gider. */
  | { status: "created"; href: string }
  /** Sohbet kullanilamiyor ya da tavan: yeni sekme `/ara` (yapay zekasiz) yoluna gider. */
  | { status: "fallback"; href: string }
  | { status: "error" };

/**
 * Yeni sekme (`/sohbet/yeni`) acilista cagirir: sohbeti ve ilk mesaji TEK islemde
 * olusturur, kimligi hemen dondurur; ilk turu (Gemini) yanit gittikten SONRA
 * `after()` ile baslatir. Ilk tur eskiden gezinme + SSR + hydration + ikinci
 * sunucu eylemi sonrasi basliyordu. `after()` ayni `processPendingTurn`i
 * kullanir: kira (`processing_until`) ayni anda ikinci Gemini cagrisini
 * engeller; is dusse istemci kurtarma yolu (`runTurnAction`) devralir.
 * Gemini bu eylemin yanitini ve DB islemini BEKLETMEZ.
 */
export async function startChatBootstrapAction(text: unknown): Promise<NewTabChatResult> {
  const timer = createChatTimer();
  const message = typeof text === "string" ? text.trim().slice(0, 500) : "";
  if (!message) return { status: "error" };
  const user = await timer.time("session", () => verifySession());
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { status: "fallback", href: plainSearchHref(message) };
  }
  const db = getDatabase();
  const created = await timer.time("create_conversation", () =>
    createConversation(db, { userId: user.id, message }),
  );
  logChatTimings("create", created.status, timer.finish());
  if (created.status !== "created") {
    return created.status === "rate_limited"
      ? { status: "fallback", href: plainSearchHref(message) }
      : { status: "error" };
  }
  const { conversationId } = created;
  scheduleInitialTurn(db, user.id, conversationId);
  return { status: "created", href: `/sohbet/${conversationId}` };
}

/**
 * "Bu yardimci oldu mu?" oyu (karar 0075, 0079). Olumsuz oy yalnizca Gonder ile gelir;
 * neden/yorum istege baglidir. Sahiplik ve dogrulama cekirdekte; burada oturum + oran siniri.
 * Analitik olayi uretmez.
 */
export async function submitResultFeedbackAction(
  conversationId: string,
  messageSeq: number,
  helpful: boolean,
  details?: { reasons?: string[]; comment?: string },
): Promise<{ status: "saved" | "not_found" | "invalid" | "unavailable" | "rate_limited" }> {
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { status: "unavailable" };
  }
  if (typeof conversationId !== "string" || typeof helpful !== "boolean") {
    return { status: "invalid" };
  }
  try {
    if (!(await consumeChatFeedbackQuota(user.id))) return { status: "rate_limited" };
  } catch (error) {
    // Redis yok: yazma yolu fail-closed (sohbet etkilenmez).
    if (isRedisUnavailableError(error)) return { status: "unavailable" };
    throw error;
  }
  return {
    status: await setResultFeedback(getDatabase(), {
      userId: user.id,
      conversationId,
      messageSeq: Number(messageSeq),
      helpful,
      reasons: details?.reasons,
      comment: details?.comment,
    }),
  };
}

export type ChatLinkPollState = "pending" | "done" | "unavailable";

/**
 * Link incelemesi bitti mi? (karar 0090). Istemci yalnizca sohbet kimligi ve mesaj
 * sirasini gonderir; `requestId` sahibin kendi mesajindan okunur (baskasinin
 * istegi sorgulanamaz). Durum okuma cekirdekte (`getChatLinkView`: hak uzlasmasi
 * dahil). Sonucu sunucu bileseni cizer; burada yalnizca sabit durum kodu doner.
 */
export async function pollChatLinkAction(
  conversationId: string,
  messageSeq: number,
): Promise<{ state: ChatLinkPollState }> {
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !isChatLinkEnabled() || !user || !canAccessProduct(user)) {
    return { state: "unavailable" };
  }
  if (typeof conversationId !== "string" || !isUuid(conversationId)) {
    return { state: "unavailable" };
  }
  if (!Number.isInteger(messageSeq) || messageSeq < 1) return { state: "unavailable" };
  const db = getDatabase();
  const view = await loadConversation(db, { userId: user.id, conversationId });
  const message = view?.messages.find((m) => m.seq === messageSeq);
  if (message?.kind !== "notice" || !message.link) return { state: "unavailable" };
  const linkView = await getChatLinkView(db, message.link);
  return { state: linkView.state === "pending" ? "pending" : "done" };
}
