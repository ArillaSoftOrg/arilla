"use server";

import { createHash } from "node:crypto";
import {
  type AssistantPreview,
  type ChatAttachmentInput,
  type ChatInputRequest,
  canAccessProduct,
  cleanSubmissionText,
  consumeChatFeedbackQuota,
  createChatTimer,
  createConversation,
  getChatInterpreter,
  getTurnStatus,
  isChatDiscoveryEnabled,
  isChatImageEnabled,
  isRedisUnavailableError,
  isUuid,
  isValidRequestKey,
  logChatTimings,
  prepareChatImage,
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

/**
 * Istemci anahtar gondermediyse (JS'siz form, duz metin yolu) cift tiklama/yeniden gonderim
 * ikinci sohbet ve ikinci kota birimi harcamasin: ayni kullanici + ayni metin icin 10 sn'lik
 * kovada deterministik anahtar. Kova siniri seyrek bir cift gonderime izin verebilir; zararsizdir.
 */
function implicitRequestKey(userId: number, text: string, now: number = Date.now()): string {
  const bucket = Math.floor(now / 10_000);
  const digest = createHash("sha256").update(`${userId}:${bucket}:${text}`).digest("hex");
  return `auto-${digest.slice(0, 40)}`;
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
  const created = await createConversation(db, {
    userId: user.id,
    message: text,
    requestKey: implicitRequestKey(user.id, text),
  });
  // Saatlik tavan ya da gecersiz girdi: kullanici yine de arayabilir (yapay zekasiz yol).
  if (created.status !== "created") redirect(plainSearchHref(text));
  scheduleInitialTurn(db, user.id, created.conversationId);
  redirect(`/sohbet/${created.conversationId}`);
}

export type SendMessageStatus =
  | "queued"
  | "duplicate"
  | "busy"
  | "rate_limited"
  | "conversation_full"
  | "image_limit"
  | "invalid_input"
  | "invalid_type"
  | "too_large"
  | "unprocessable"
  | "invalid_option"
  | "not_found"
  | "unavailable"
  | "error";

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

/**
 * Kullanici mesajini kaydeder (model cagrisi yok). Karar 0091: `photo` verilirse
 * (`FormData{photo}`) gorsel AYNI mesajin eki olur ve mevcut konusmaya eklenir; metin,
 * secenek ve atla yolu ayni kalir. Gorsel burada dogrulanir ve on islenir.
 */
export async function sendMessageAction(
  conversationId: string,
  request: unknown,
  requestKey: string,
  photo?: FormData,
): Promise<{ status: SendMessageStatus }> {
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { status: "unavailable" };
  }
  const parsed = parseRequest(request);
  if (!parsed || typeof conversationId !== "string" || !isUuid(conversationId)) {
    return { status: "invalid_input" };
  }
  let attachment: ChatAttachmentInput | undefined;
  if (photo !== undefined) {
    // Bayrak kapaliyken gorsel hicbir kosulda islenmez ya da eski aramaya dusulmez.
    if (!isChatImageEnabled()) return { status: "unavailable" };
    const prepared = await prepareChatImage(photo instanceof FormData ? photo.get("photo") : null);
    if (!prepared.ok) return { status: prepared.status };
    attachment = prepared.attachment;
  }
  let result: Awaited<ReturnType<typeof submitUserMessage>>;
  try {
    result = await submitUserMessage(getDatabase(), {
      userId: user.id,
      conversationId,
      request: parsed,
      requestKey: typeof requestKey === "string" ? requestKey : undefined,
      ...(attachment ? { attachment } : {}),
    });
  } catch (error) {
    // Metin yolu onceki gibi hatayi iletir; yalniz gorselli gonderimde sabit kod doner.
    if (!attachment) throw error;
    return { status: "error" };
  }
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
  | { status: "error" }
  /**
   * Karar 0091, yalniz GORSELLI mesaj: eski aramaya dusulmez, kullanici sohbet icinde hatayi
   * gorur ve tekrar dener. Metin mesajinda bu durumlar yukaridaki `fallback`/`error` ile ayni kalir.
   */
  | {
      status: "image_rejected";
      reason: "invalid_type" | "too_large" | "unprocessable" | "invalid_input";
    }
  | { status: "rate_limited" | "unavailable" | "login_required" };

interface NewChatSubmission {
  text: string;
  /** `FormData.photo`; yoksa `null`. Gecerlilik `prepareChatImage`te denetlenir. */
  image: unknown;
  requestKey: string | undefined;
  /** Gorsel gonderildi ama istek anahtari gecersiz. */
  invalidKey: boolean;
}

/**
 * Metin-only: duz metin (onceki sozlesme, degismedi). Gorselli: `FormData{q, photo, requestKey}`.
 * Ikisi de ayni eylemden ayni hatta gecer (karar 0091).
 */
function readNewChatSubmission(input: unknown): NewChatSubmission {
  if (typeof input === "string") {
    return {
      text: cleanSubmissionText(input),
      image: null,
      requestKey: undefined,
      invalidKey: false,
    };
  }
  if (input instanceof FormData) {
    const photo = input.get("photo");
    const key = input.get("requestKey");
    const hasKey = isValidRequestKey(key);
    return {
      text: cleanSubmissionText(input.get("q")),
      image: photo,
      requestKey: hasKey ? key : undefined,
      invalidKey: photo !== null && !hasKey,
    };
  }
  return { text: "", image: null, requestKey: undefined, invalidKey: false };
}

/**
 * Yeni sekme (`/sohbet/yeni`) acilista cagirir: sohbeti ve ilk mesaji TEK islemde
 * olusturur, kimligi hemen dondurur; ilk turu (Gemini) yanit gittikten SONRA
 * `after()` ile baslatir. Ilk tur eskiden gezinme + SSR + hydration + ikinci
 * sunucu eylemi sonrasi basliyordu. `after()` ayni `processPendingTurn`i
 * kullanir: kira (`processing_until`) ayni anda ikinci Gemini cagrisini
 * engeller; is dusse istemci kurtarma yolu (`runTurnAction`) devralir.
 * Gemini bu eylemin yanitini ve DB islemini BEKLETMEZ.
 *
 * Karar 0091: mesaj metin, gorsel ya da ikisi birden olabilir; hepsi bu hattan gecer.
 * Gorselli mesajda bayrak/oturum yoksa `/ara`ya dusulmez (eski gorsel arama kalkti).
 */
export async function startChatBootstrapAction(input: unknown): Promise<NewTabChatResult> {
  const timer = createChatTimer();
  const submission = readNewChatSubmission(input);
  const hasImage = submission.image !== null && submission.image !== undefined;
  const message = submission.text;
  if (!message && !hasImage) return { status: "error" };
  const user = await timer.time("session", () => verifySession());

  let attachment: ChatAttachmentInput | undefined;
  if (hasImage) {
    if (!user) return { status: "login_required" };
    if (!isChatDiscoveryEnabled() || !isChatImageEnabled() || !canAccessProduct(user)) {
      return { status: "unavailable" };
    }
    if (submission.invalidKey) return { status: "image_rejected", reason: "invalid_input" };
    const prepared = await prepareChatImage(submission.image);
    if (!prepared.ok) {
      return prepared.status === "error"
        ? { status: "error" }
        : { status: "image_rejected", reason: prepared.status };
    }
    attachment = prepared.attachment;
  } else if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) {
    return { status: "fallback", href: plainSearchHref(message) };
  }
  if (!user) return { status: "error" };

  const db = getDatabase();
  let created: Awaited<ReturnType<typeof createConversation>>;
  try {
    created = await timer.time("create_conversation", () =>
      createConversation(db, {
        userId: user.id,
        message,
        // Gorselli gonderim kendi anahtarini tasir; metin-yalniz yolda anahtar yoksa ortuk anahtar.
        requestKey: submission.requestKey ?? implicitRequestKey(user.id, message),
        ...(attachment ? { attachment } : {}),
      }),
    );
  } catch (error) {
    // Metin yolu onceki gibi hatayi iletir; yalniz gorselli gonderimde sabit kod doner.
    if (!attachment) throw error;
    return { status: "error" };
  }
  logChatTimings("create", created.status, timer.finish());
  if (created.status !== "created") {
    if (created.status === "rate_limited") {
      return attachment
        ? { status: "rate_limited" }
        : { status: "fallback", href: plainSearchHref(message) };
    }
    return { status: "error" };
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
