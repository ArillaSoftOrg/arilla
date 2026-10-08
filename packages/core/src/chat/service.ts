/**
 * Sohbet kaliciligi ve tur orkestrasyonu (docs/decisions/0074).
 *
 * Akis (iki ayri adim, ikisi de tekrar-guvenli):
 *   1. `createConversation` / `submitUserMessage`: kullanici mesajini kaydeder.
 *      Model cagrisi YOK; kisa bir islem + satir kilidi.
 *   2. `processPendingTurn`: cevaplanmamis son kullanici mesajini yorumlar ve
 *      asistan mesajini yazar. Model cagrisi islem DISINDADIR; es zamanli ikinci
 *      tur `processing_until` kirasiyla engellenir.
 *
 * Her sorgu `user_id` ile birlikte yapilir: baskasinin sohbeti `not_found`.
 * Hicbir yerde mesaj metni loglanmaz.
 */

import { createHash } from "node:crypto";
import {
  apiUsage,
  chatAttachment,
  chatMessage,
  chatResultFeedback,
  conversation,
  type Database,
} from "@arilla/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { LlmErrorCode } from "../llm/client.ts";
import { loadLexiconCached } from "../search/lexicon-cache.ts";
import { providerCallsToday } from "../search/query-interpretation.ts";
import {
  CHAT_DAILY_CALL_CAP,
  CHAT_LEASE_SECONDS,
  CHAT_RETENTION_DAYS,
  CHAT_TURN_OPERATION,
  chatTurnsPerHour,
  isChatImageEnabled,
  MAX_USER_MESSAGES_PER_CONVERSATION,
  USER_MESSAGE_MAX,
} from "./config.ts";
import {
  type ClarifyQuestion,
  cleanText,
  parseClarifyQuestion,
  type SearchIntent,
} from "./contract.ts";
import {
  CHAT_ATTACHMENTS_PER_CONVERSATION,
  decideContextImage,
  type ImageContextDecision,
} from "./image-context.ts";
import { mergeSearchIntent, parseStoredIntent } from "./intent.ts";
import {
  CHAT_CONTEXT_MESSAGES,
  type ChatImageInput,
  type ChatInterpreter,
  fallbackTurn,
  type InterpretRequest,
  interpretTurn,
  type TranscriptMessage,
  type UserInput,
} from "./interpreter.ts";
import { type ChatTimings, createChatTimer, logChatTimings } from "./timing.ts";

export type ChatInputRequest =
  | { kind: "text"; text: string }
  | { kind: "option"; questionId: string; value: string }
  | { kind: "skip"; questionId: string };

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

// ---------------------------------------------------------------------------
// Okuma
// ---------------------------------------------------------------------------

/** Karar 0080: asistan mesajinin `payload.imageSummary` kaydi. */
export interface StoredImageSummary {
  attachmentId: string;
  text: string;
}

export type ChatMessageView =
  | {
      id: number;
      seq: number;
      role: "user";
      kind: "text" | "option" | "skip";
      content: string;
      /** `option` icin secilen degerin kimligi (sunucuda dogrulanmis). */
      value: string | null;
      /** Karar 0078: mesaja eklenen gorselin kimligi (`/sohbet/gorsel/[id]`); yoksa `null`. */
      attachmentId?: string | null;
    }
  | {
      id: number;
      seq: number;
      role: "assistant";
      kind: "clarify";
      content: string;
      question: ClarifyQuestion | null;
      /** Karar 0080: bu turda modelin urettigi gorsel ozeti (hangi eke ait oldugu ile). */
      imageSummary?: StoredImageSummary | null;
    }
  | {
      id: number;
      seq: number;
      role: "assistant";
      kind: "search" | "notice";
      content: string;
      intent: SearchIntent | null;
      source: "model" | "fallback" | null;
      /** 0055: sonuc blogune verilen oy; `null` = oy yok. */
      helpful: boolean | null;
      imageSummary?: StoredImageSummary | null;
    };

export interface ConversationView {
  id: string;
  title: string;
  currentIntent: SearchIntent | null;
  pendingQuestion: ClarifyQuestion | null;
  /** Son mesaj kullanicinindir: asistan cevabi bekleniyor. */
  awaitingReply: boolean;
  messages: ChatMessageView[];
}

/** Yalnizca yazili kimlik; sahiplik sunum aninda sorguda denetlenir. */
function attachmentIdOf(payload: Record<string, unknown> | null): string | null {
  const id = payload?.attachmentId;
  return typeof id === "string" && isUuid(id) ? id : null;
}

function imageSummaryOf(payload: Record<string, unknown> | null): StoredImageSummary | null {
  const raw = payload?.imageSummary;
  if (typeof raw !== "object" || raw === null) return null;
  const { attachmentId, text } = raw as Record<string, unknown>;
  if (typeof attachmentId !== "string" || !isUuid(attachmentId)) return null;
  if (typeof text !== "string" || text.length === 0) return null;
  return { attachmentId, text };
}

/** Ozet yoksa alan hic eklenmez: eski gorunum sekli (ve testleri) degismez. */
function withSummary(
  payload: Record<string, unknown> | null,
): { imageSummary: StoredImageSummary } | Record<string, never> {
  const summary = imageSummaryOf(payload);
  return summary ? { imageSummary: summary } : {};
}

/** Yalniz fotograf gonderildiginde `content` yer tutucudur; gorunumde bos sayilir. */
export const IMAGE_ONLY_CONTENT = "(görsel)";

function sourceOf(payload: Record<string, unknown> | null): "model" | "fallback" | null {
  const source = payload?.source;
  return source === "model" || source === "fallback" ? source : null;
}

function toView(
  row: typeof chatMessage.$inferSelect,
  helpful: boolean | null = null,
): ChatMessageView {
  const payload = row.payload;
  if (row.role === "user") {
    return {
      id: row.id,
      seq: row.seq,
      role: "user",
      kind: row.kind === "option" || row.kind === "skip" ? row.kind : "text",
      content: payload?.imageOnly === true ? "" : row.content,
      value: typeof payload?.value === "string" ? payload.value : null,
      attachmentId: attachmentIdOf(payload),
    };
  }
  if (row.kind === "clarify") {
    return {
      id: row.id,
      seq: row.seq,
      role: "assistant",
      kind: "clarify",
      content: row.content,
      question: parseClarifyQuestion(payload?.question),
      ...withSummary(payload),
    };
  }
  return {
    id: row.id,
    seq: row.seq,
    role: "assistant",
    kind: row.kind === "notice" ? "notice" : "search",
    content: row.content,
    intent: parseStoredIntent(payload?.intent),
    source: sourceOf(payload),
    helpful,
    ...withSummary(payload),
  };
}

function buildView(
  row: typeof conversation.$inferSelect,
  rows: readonly (typeof chatMessage.$inferSelect)[],
  helpfulById: ReadonlyMap<number, boolean> = new Map(),
): ConversationView {
  const messages = rows.map((message) => toView(message, helpfulById.get(message.id) ?? null));
  return {
    id: row.id,
    title: row.title,
    currentIntent: parseStoredIntent(row.currentSearchIntent),
    pendingQuestion: parseClarifyQuestion(row.pendingQuestion),
    awaitingReply: messages.at(-1)?.role === "user",
    messages,
  };
}

function loadMessageRows(db: Executor, conversationId: string) {
  return db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, conversationId))
    .orderBy(asc(chatMessage.seq));
}

/** Sahiplik denetimi sorguda: baskasinin ya da olmayan sohbet icin `null`. */
export async function loadConversation(
  db: Executor,
  input: { userId: number; conversationId: string },
): Promise<ConversationView | null> {
  if (!isUuid(input.conversationId)) return null;
  const [row] = await db
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.userId, input.userId)));
  if (!row) return null;
  // Mesajlar ve oylar birbirine bagimli degil: tek tur.
  const [rows, votes] = await Promise.all([
    loadMessageRows(db, row.id),
    db
      .select({ messageId: chatResultFeedback.messageId, helpful: chatResultFeedback.helpful })
      .from(chatResultFeedback)
      .where(eq(chatResultFeedback.conversationId, row.id))
      .catch((error: unknown) => {
        // 0055 henuz uygulanmamis bir veritabaninda (kod migration'dan once dagitilirsa) oy yok sayilir.
        if (isMissingTable(error)) return [];
        throw error;
      }),
  ]);
  return buildView(row, rows, new Map(votes.map((vote) => [vote.messageId, vote.helpful])));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Yazma: kullanici mesaji
// ---------------------------------------------------------------------------

export type CreateConversationResult =
  | { status: "created"; conversationId: string }
  | { status: "invalid_input" }
  | { status: "rate_limited" };

export type SubmitMessageResult =
  | { status: "queued"; seq: number }
  | { status: "duplicate" }
  | { status: "busy" }
  | { status: "rate_limited" }
  | { status: "conversation_full" }
  /** Karar 0080: konusma basina gorsel ust siniri doldu. */
  | { status: "image_limit" }
  | { status: "invalid_input" }
  | { status: "invalid_option" }
  | { status: "not_found" };

function cleanUserText(value: unknown): string | null {
  return cleanText(value, USER_MESSAGE_MAX);
}

function requestKeyOrNull(value: string | undefined): string | null {
  return value !== undefined && value.length >= 8 && value.length <= 100 ? value : null;
}

/** Kullanicinin son bir saatteki mesaj sayisi (tum sohbetler). Model maliyet tavani. */
async function recentUserMessageCount(db: Executor, userId: number): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM chat_message m
      JOIN conversation c ON c.id = m.conversation_id
     WHERE c.user_id = ${userId}
       AND m.role = 'user'
       AND m.created_at > now() - interval '1 hour'
  `);
  const row = result.rows[0] as { n?: number } | undefined;
  return row?.n ?? 0;
}

/** Karar 0078: `preprocessImage` ciktisi (<= 512 KB; DB CHECK ile ayni sinir). */
export interface ChatAttachmentInput {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export const CHAT_ATTACHMENT_MAX_BYTES = 512 * 1024;
const IMAGE_ONLY_TITLE = "Fotoğrafla arama";

/** Ayni `requestKey` ile gelen ikinci olusturma yeni sohbet acmaz, mevcut olani doner. */
async function findConversationByRequestKey(
  db: Executor,
  userId: number,
  requestKey: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT c.id
      FROM chat_message m
      JOIN conversation c ON c.id = m.conversation_id
     WHERE c.user_id = ${userId} AND m.client_request_id = ${requestKey} AND m.seq = 1
     LIMIT 1
  `);
  const row = result.rows[0] as { id?: string } | undefined;
  return row?.id ?? null;
}

function validAttachment(attachment: ChatAttachmentInput): boolean {
  return (
    Buffer.isBuffer(attachment.bytes) &&
    attachment.bytes.byteLength >= 1 &&
    attachment.bytes.byteLength <= CHAT_ATTACHMENT_MAX_BYTES &&
    (attachment.mimeType === "image/jpeg" || attachment.mimeType === "image/png") &&
    Number.isInteger(attachment.width) &&
    Number.isInteger(attachment.height) &&
    attachment.width >= 1 &&
    attachment.height >= 1
  );
}

/**
 * Sohbeti, (varsa) gorsel eki ve ilk kullanici mesajini TEK islemde yazar: yarim
 * kalmis sohbet/ek olmaz. Gorsel varsa metin bos olabilir (yalniz fotograf).
 * Ayni `requestKey` mevcut sohbeti doner (cift gonderim ikinci sohbet acmaz).
 */
export async function createConversation(
  db: Database,
  input: {
    userId: number;
    message: string;
    requestKey?: string;
    attachment?: ChatAttachmentInput;
  },
): Promise<CreateConversationResult> {
  const attachment = input.attachment;
  if (attachment && !validAttachment(attachment)) return { status: "invalid_input" };
  const text = cleanUserText(input.message);
  if (text === null && !attachment) return { status: "invalid_input" };
  const requestKey = requestKeyOrNull(input.requestKey);
  if (requestKey !== null) {
    const existing = await findConversationByRequestKey(db, input.userId, requestKey);
    if (existing) return { status: "created", conversationId: existing };
  }
  if ((await recentUserMessageCount(db, input.userId)) >= chatTurnsPerHour()) {
    return { status: "rate_limited" };
  }
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(conversation)
      .values({
        userId: input.userId,
        title: (text ?? IMAGE_ONLY_TITLE).slice(0, 80),
        messageCount: 1,
      })
      .returning({ id: conversation.id });
    if (!created) throw new Error("conversation insert returned no row");
    let payload: Record<string, unknown> | null = null;
    if (attachment) {
      const [stored] = await tx
        .insert(chatAttachment)
        .values({
          conversationId: created.id,
          userId: input.userId,
          mimeType: attachment.mimeType,
          data: attachment.bytes,
          width: attachment.width,
          height: attachment.height,
          sha256: createHash("sha256").update(attachment.bytes).digest("hex"),
        })
        .returning({ id: chatAttachment.id });
      if (!stored) throw new Error("attachment insert returned no row");
      payload =
        text === null ? { attachmentId: stored.id, imageOnly: true } : { attachmentId: stored.id };
    }
    await tx.insert(chatMessage).values({
      conversationId: created.id,
      seq: 1,
      role: "user",
      kind: "text",
      content: text ?? IMAGE_ONLY_CONTENT,
      payload,
      clientRequestId: requestKey,
    });
    return { status: "created", conversationId: created.id } as const;
  });
}

export interface LoadedChatAttachment {
  mimeType: "image/jpeg" | "image/png";
  data: Buffer;
}

/** Sahiplik sorguda: baskasinin/olmayan/gecersiz kimlik icin `null`. */
export async function loadChatAttachment(
  db: Executor,
  input: { userId: number; attachmentId: string },
): Promise<LoadedChatAttachment | null> {
  if (!isUuid(input.attachmentId)) return null;
  const [row] = await db
    .select({ mimeType: chatAttachment.mimeType, data: chatAttachment.data })
    .from(chatAttachment)
    .where(and(eq(chatAttachment.id, input.attachmentId), eq(chatAttachment.userId, input.userId)));
  return row ?? null;
}

/**
 * Kullanici mesajini ekler. Satir kilidi altinda: son mesaj kullanicinin ise
 * (cevap bekleniyor) ikinci mesaj `busy`; ayni `requestKey` ikinci kez `duplicate`.
 */
export async function submitUserMessage(
  db: Database,
  input: {
    userId: number;
    conversationId: string;
    request: ChatInputRequest;
    requestKey?: string;
    /**
     * Karar 0080: mesajin gorsel eki (metinle ayni mesaj). Yalniz `text` istegiyle birlikte;
     * metin bos olabilir (yalniz fotograf). Ek, mesajla TEK islemde yazilir.
     */
    attachment?: ChatAttachmentInput;
  },
): Promise<SubmitMessageResult> {
  if (!isUuid(input.conversationId)) return { status: "not_found" };
  const requestKey = requestKeyOrNull(input.requestKey);
  const attachment = input.attachment;
  if (attachment && (!validAttachment(attachment) || input.request.kind !== "text")) {
    return { status: "invalid_input" };
  }

  // Kisa, kilitsiz on kontrol: model maliyet tavani.
  if ((await recentUserMessageCount(db, input.userId)) >= chatTurnsPerHour()) {
    // Ayni anahtarla tekrar gelen istek tavanda da "duplicate" sayilmali; asagida kontrol edilir.
    if (requestKey === null || !(await requestKeyExists(db, input.conversationId, requestKey))) {
      return { status: "rate_limited" };
    }
  }

  return db.transaction(async (tx): Promise<SubmitMessageResult> => {
    const [row] = await tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.userId, input.userId)))
      .for("update");
    if (!row) return { status: "not_found" };

    if (requestKey !== null && (await requestKeyExists(tx, row.id, requestKey))) {
      return { status: "duplicate" };
    }

    const [last] = await tx
      .select({ role: chatMessage.role })
      .from(chatMessage)
      .where(and(eq(chatMessage.conversationId, row.id), eq(chatMessage.seq, row.messageCount)));
    if (last?.role === "user") return { status: "busy" };

    const userMessages = await tx.execute(sql`
      SELECT count(*)::int AS n FROM chat_message
       WHERE conversation_id = ${row.id} AND role = 'user'
    `);
    if (
      ((userMessages.rows[0] as { n?: number } | undefined)?.n ?? 0) >=
      MAX_USER_MESSAGES_PER_CONVERSATION
    ) {
      return { status: "conversation_full" };
    }
    if (attachment) {
      const attachments = await tx.execute(sql`
        SELECT count(*)::int AS n FROM chat_attachment WHERE conversation_id = ${row.id}
      `);
      if (
        ((attachments.rows[0] as { n?: number } | undefined)?.n ?? 0) >=
        CHAT_ATTACHMENTS_PER_CONVERSATION
      ) {
        return { status: "image_limit" };
      }
    }

    const pending = parseClarifyQuestion(row.pendingQuestion);
    let kind: "text" | "option" | "skip";
    let content: string;
    let payload: Record<string, unknown> | null = null;
    const request = input.request;
    if (request.kind === "text") {
      const text = cleanUserText(request.text);
      if (text === null && !attachment) return { status: "invalid_input" };
      kind = "text";
      content = text ?? IMAGE_ONLY_CONTENT;
      if (pending) payload = { answersQuestion: pending.id };
      if (attachment) {
        const [stored] = await tx
          .insert(chatAttachment)
          .values({
            conversationId: row.id,
            userId: input.userId,
            mimeType: attachment.mimeType,
            data: attachment.bytes,
            width: attachment.width,
            height: attachment.height,
            sha256: createHash("sha256").update(attachment.bytes).digest("hex"),
          })
          .returning({ id: chatAttachment.id });
        if (!stored) throw new Error("attachment insert returned no row");
        payload = {
          ...(payload ?? {}),
          attachmentId: stored.id,
          ...(text === null ? { imageOnly: true } : {}),
        };
      }
    } else if (request.kind === "option") {
      // Gecerli secenek sunucuda dogrulanir: istemci etiket ya da deger uyduramaz.
      const option =
        pending && pending.id === request.questionId
          ? pending.options.find((candidate) => candidate.value === request.value)
          : undefined;
      if (!option || !pending) return { status: "invalid_option" };
      kind = "option";
      content = option.label;
      payload = { questionId: pending.id, value: option.value };
    } else {
      if (!pending || pending.id !== request.questionId) return { status: "invalid_option" };
      kind = "skip";
      content = "Atla";
      payload = { questionId: pending.id };
    }

    const seq = row.messageCount + 1;
    await tx.insert(chatMessage).values({
      conversationId: row.id,
      seq,
      role: "user",
      kind,
      content,
      payload,
      clientRequestId: requestKey,
    });
    await tx
      .update(conversation)
      .set({ messageCount: seq, lastMessageAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(conversation.id, row.id));
    return { status: "queued", seq };
  });
}

async function requestKeyExists(
  db: Executor,
  conversationId: string,
  requestKey: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.conversationId, conversationId),
        eq(chatMessage.clientRequestId, requestKey),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Tur isleme
// ---------------------------------------------------------------------------

export type ProcessTurnResult =
  | { status: "answered"; source: "model" | "fallback"; action: "clarify" | "search" }
  /** Baska bir tur bu sohbeti isliyor; cagiran biraz sonra tekrar bakar. */
  | { status: "busy" }
  /** Cevaplanmamis kullanici mesaji yok. */
  | { status: "idle" }
  | { status: "not_found" }
  | { status: "provider_error"; code: LlmErrorCode | "unknown" };

function transcriptText(message: ChatMessageView): string {
  if (message.role === "user") {
    return message.kind === "skip" ? "(soruyu atladı)" : message.content;
  }
  if (message.kind === "clarify" && message.question) {
    const options = message.question.options.map((option) => option.label).join(" / ");
    return `${message.content} [soru: ${message.question.title}; seçenekler: ${options}]`;
  }
  return message.content;
}

/** Son kullanici mesajindan once, aralarinda `search` olmadan sorulan art arda soru sayisi. */
export function countTrailingClarifications(messages: readonly ChatMessageView[]): number {
  let count = 0;
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (message.kind === "clarify") count++;
    else break;
  }
  return count;
}

function toInterpretRequest(
  view: ConversationView,
  decision: ImageContextDecision,
  image: ChatImageInput | null = null,
): InterpretRequest | null {
  const last = view.messages.at(-1);
  if (last?.role !== "user") return null;
  const pending = view.pendingQuestion;
  let input: UserInput;
  if (last.kind === "option" && pending) {
    input = {
      kind: "option",
      questionId: pending.id,
      value: last.value ?? "",
      label: last.content,
    };
  } else if (last.kind === "skip") {
    input = { kind: "skip", questionId: pending?.id ?? null };
  } else {
    input = { kind: "text", text: last.content };
  }
  // Karar 0080: gorsel yalnizca karar verilen mesaja EKLENIR (`hasImage`); diger gorselli
  // mesajlar, kayitli ozetleri varsa onunla temsil edilir.
  const summaries = new Map<string, string>();
  for (const message of view.messages) {
    if (message.role === "assistant" && message.imageSummary) {
      summaries.set(message.imageSummary.attachmentId, message.imageSummary.text);
    }
  }
  const messages: TranscriptMessage[] = view.messages.map((message, index) => {
    const base = { role: message.role, kind: message.kind, text: transcriptText(message) };
    if (message.role !== "user" || !message.attachmentId) return base;
    if (image && index === decision.ownerIndex) return { ...base, hasImage: true };
    const summary = summaries.get(message.attachmentId);
    return summary ? { ...base, imageSummary: summary } : base;
  });
  return {
    messages,
    currentIntent: view.currentIntent,
    pendingQuestion: pending ? { id: pending.id, title: pending.title } : null,
    clarifyCount: countTrailingClarifications(view.messages),
    input,
    image,
  };
}

/**
 * Karar 0078/0080: modele eklenecek gorsel. `decideContextImage` EN SON gorselli
 * kullanici mesajini secer ve gorselin gonderilip gonderilmeyecegine karar verir
 * (kendi turu, kayitli ozet yoksa ya da atif varsa). Pencere disina cikarsa eklenmez.
 */
async function loadContextImage(
  db: Executor,
  userId: number,
  decision: ImageContextDecision,
): Promise<ChatImageInput | null> {
  if (!isChatImageEnabled() || !decision.sendImage || !decision.attachmentId) return null;
  try {
    const loaded = await loadChatAttachment(db, { userId, attachmentId: decision.attachmentId });
    return loaded
      ? { mimeType: loaded.mimeType, dataBase64: loaded.data.toString("base64") }
      : null;
  } catch {
    // Ek okunamadi: tur metinle surer; sohbet kesilmez.
    return null;
  }
}

async function releaseLease(db: Executor, conversationId: string): Promise<void> {
  await db
    .update(conversation)
    .set({ processingUntil: null })
    .where(eq(conversation.id, conversationId));
}

/**
 * Cevaplanmamis son kullanici mesajini yorumlar ve asistan mesajini yazar.
 * Asla firlatmaz; beklenmeyen hata `provider_error/unknown` olur ve kira birakilir.
 */
export async function processPendingTurn(
  db: Database,
  input: ProcessTurnInput,
): Promise<ProcessTurnResult> {
  return (await processPendingTurnDetailed(db, input)).result;
}

export interface ProcessTurnInput {
  userId: number;
  conversationId: string;
  interpreter: ChatInterpreter;
  leaseSeconds?: number;
}

/** Yazilan cevabin istemcide hemen gosterilebilen on izlemesi (kalici kayit sunucudadir). */
export interface AssistantPreview {
  seq: number;
  kind: "clarify" | "search";
  content: string;
}

export interface DetailedTurnResult {
  result: ProcessTurnResult;
  preview: AssistantPreview | null;
  timings: ChatTimings;
}

/**
 * `processPendingTurn` + olcumler + cevabin on izlemesi. Davranis ayni: atomik
 * kira (tek UPDATE ... RETURNING, sahiplik WHERE'de), kira altinda bagimsiz
 * okumalar tek turda, Gemini islem DISINDA, cevap tek islemde.
 */
export async function processPendingTurnDetailed(
  db: Database,
  input: ProcessTurnInput,
): Promise<DetailedTurnResult> {
  const timer = createChatTimer();
  const captured: { preview: AssistantPreview | null } = { preview: null };
  const result = await runPendingTurn(db, input, timer, (value) => {
    captured.preview = value;
  });
  const timings = timer.finish();
  logChatTimings("turn", result.status, timings);
  return { result, preview: result.status === "answered" ? captured.preview : null, timings };
}

async function runPendingTurn(
  db: Database,
  input: ProcessTurnInput,
  timer: ReturnType<typeof createChatTimer>,
  setPreview: (preview: AssistantPreview) => void,
): Promise<ProcessTurnResult> {
  if (!isUuid(input.conversationId)) return { status: "not_found" };
  const lease = input.leaseSeconds ?? CHAT_LEASE_SECONDS;

  // Atomik kira: ayni anda tek tur. Sure dolmus kira (cokmus is) yeniden alinabilir.
  // RETURNING tum satiri doner: ayri bir sohbet okumasi gerekmez.
  const acquired = await timer.time("claim_turn", () =>
    db
      .update(conversation)
      .set({ processingUntil: sql`now() + make_interval(secs => ${lease})` })
      .where(
        and(
          eq(conversation.id, input.conversationId),
          eq(conversation.userId, input.userId),
          or(isNull(conversation.processingUntil), lt(conversation.processingUntil, sql`now()`)),
        ),
      )
      .returning(),
  );
  const claimed = acquired[0];
  if (!claimed) {
    const [exists] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.userId, input.userId)));
    return exists ? { status: "busy" } : { status: "not_found" };
  }

  try {
    // Birbirine bagimli degil, tek tur: mesajlar, gunluk tavan, sozluk isitma (aramadan once).
    const [rows, callsToday] = await Promise.all([
      timer.time("load_context", () => loadMessageRows(db, claimed.id)),
      timer.time("provider_limit", () => providerCallsToday(db, new Date(), CHAT_TURN_OPERATION)),
      timer.time("lexicon", () => loadLexiconCached(db)).catch(() => undefined),
    ]);
    const view = buildView(claimed, rows);
    const decision = decideContextImage(view.messages, CHAT_CONTEXT_MESSAGES);
    const image = await loadContextImage(db, input.userId, decision);
    const maybeRequest = toInterpretRequest(view, decision, image);
    if (!maybeRequest) {
      await releaseLease(db, input.conversationId);
      return { status: "idle" };
    }
    const request: InterpretRequest = maybeRequest;
    const lastSeq = view.messages.at(-1)?.seq ?? 0;
    // Kilit/islem YOK: kira yalnizca bir satir isaretidir; model cagrisi DB'yi tutmaz.
    const modelAllowed = callsToday < CHAT_DAILY_CALL_CAP;
    const outcome = await timer.time("gemini", () =>
      interpretTurn(input.interpreter, request, { modelAllowed }),
    );

    return await persistTurn();

    function persistTurn(): Promise<ProcessTurnResult> {
      return timer.time("persist", () =>
        db.transaction(async (tx): Promise<ProcessTurnResult> => {
          const [row] = await tx
            .select()
            .from(conversation)
            .where(eq(conversation.id, input.conversationId))
            .for("update");
          if (!row) return { status: "not_found" };

          // Kural 9: her HTTP denemesi (basarisiz olanlar dahil) bir satir.
          if (outcome.calls.length > 0) {
            await tx.insert(apiUsage).values(
              outcome.calls.map((call) => ({
                sessionId: null,
                userId: input.userId,
                operation: CHAT_TURN_OPERATION,
                modelVersion: call.modelVersion,
                units: call.usage?.totalTokens ?? 0,
                costMicros: 0,
                cacheHit: false,
              })),
            );
          }

          if (outcome.kind === "provider_error") {
            await releaseLease(tx, row.id);
            return { status: "provider_error", code: outcome.code };
          }
          // Bu arada baska bir tur cevap yazdiysa (kira dolmasi) ikinci cevap yazilmaz.
          if (row.messageCount !== lastSeq) {
            await releaseLease(tx, row.id);
            return { status: "idle" };
          }

          let turn = outcome.turn;
          let source = outcome.source;
          let merged: SearchIntent | null = null;
          if (turn.action === "search") {
            merged = mergeSearchIntent(view.currentIntent, turn.intent);
            if (merged === null) {
              // Dogrulayici bunu zaten yakalar; son savunma.
              turn = fallbackTurn(request);
              source = "fallback";
              merged =
                turn.action === "search"
                  ? mergeSearchIntent(view.currentIntent, turn.intent)
                  : null;
            }
            if (merged === null) {
              await releaseLease(tx, row.id);
              return { status: "provider_error", code: "unknown" };
            }
          }

          // Karar 0080: gorsel bu istege eklendiyse modelin urettigi ozet saklanir (kural 3).
          const summaryPayload =
            image && decision.attachmentId && turn.imageSummary && source === "model"
              ? { imageSummary: { attachmentId: decision.attachmentId, text: turn.imageSummary } }
              : {};
          const seq = row.messageCount + 1;
          if (turn.action === "clarify") {
            await tx.insert(chatMessage).values({
              conversationId: row.id,
              seq,
              role: "assistant",
              kind: "clarify",
              content: turn.message,
              payload: { question: turn.question, source, ...summaryPayload },
            });
            await tx
              .update(conversation)
              .set({
                pendingQuestion: turn.question as unknown as Record<string, unknown>,
                messageCount: seq,
                processingUntil: null,
                lastMessageAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(eq(conversation.id, row.id));
            setPreview({ seq, kind: "clarify", content: turn.message });
            return { status: "answered", source, action: "clarify" };
          }

          await tx.insert(chatMessage).values({
            conversationId: row.id,
            seq,
            role: "assistant",
            kind: "search",
            content: turn.message,
            payload: {
              intent: merged,
              source,
              fallbackReason: outcome.fallbackReason,
              ...summaryPayload,
            },
          });
          await tx
            .update(conversation)
            .set({
              currentSearchIntent: merged as unknown as Record<string, unknown>,
              pendingQuestion: null,
              messageCount: seq,
              processingUntil: null,
              lastMessageAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(conversation.id, row.id));
          setPreview({ seq, kind: "search", content: turn.message });
          return { status: "answered", source, action: "search" };
        }),
      );
    }
  } catch (error) {
    // Yalnizca sinif adi: hata mesaji kullanici metni tasiyabilir.
    console.error("[sohbet] turn failed", error instanceof Error ? error.name : "unknown");
    try {
      await releaseLease(db, input.conversationId);
    } catch {
      // Kira zaten sure dolunca duser.
    }
    return { status: "provider_error", code: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Tur durumu (hafif sorgulama)
// ---------------------------------------------------------------------------

export type TurnStatus =
  | { state: "not_found" }
  /** Son mesaj kullanicinin, kira suruyor: bir tur calisiyor. */
  | { state: "in_flight" }
  /** Son mesaj kullanicinin, kira yok/dolmus: tur baslamadi ya da coktu (kurtarma). */
  | { state: "pending" }
  | { state: "answered"; preview: AssistantPreview };

interface TurnStatusRow {
  in_flight: boolean;
  role: string | null;
  kind: string | null;
  content: string | null;
  seq: number | null;
}

/** Tek sorgu; sahiplik WHERE'de. Mesaj metni yalnizca sahibine doner. */
export async function getTurnStatus(
  db: Database,
  input: { userId: number; conversationId: string },
): Promise<TurnStatus> {
  if (!isUuid(input.conversationId)) return { state: "not_found" };
  const result = await db.execute(sql`
    SELECT (c.processing_until IS NOT NULL AND c.processing_until > now()) AS in_flight,
           m.role, m.kind, m.content, m.seq
      FROM conversation c
      LEFT JOIN chat_message m ON m.conversation_id = c.id AND m.seq = c.message_count
     WHERE c.id = ${input.conversationId} AND c.user_id = ${input.userId}
  `);
  const row = result.rows[0] as TurnStatusRow | undefined;
  if (!row) return { state: "not_found" };
  if (row.role === "assistant" && typeof row.seq === "number") {
    return {
      state: "answered",
      preview: {
        seq: row.seq,
        kind: row.kind === "clarify" ? "clarify" : "search",
        content: row.content ?? "",
      },
    };
  }
  return { state: row.in_flight ? "in_flight" : "pending" };
}

// ---------------------------------------------------------------------------
// Saklama (90 gun)
// ---------------------------------------------------------------------------

export interface ConversationPurgeResult {
  deleted: number;
  truncated: boolean;
}

export async function purgeExpiredConversations(
  db: Database,
  now: Date = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<ConversationPurgeResult> {
  const batchSize = options.batchSize ?? 2_000;
  const maxBatches = options.maxBatches ?? 20;
  const cutoff = new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.execute(sql`
      DELETE FROM conversation
       WHERE id IN (
         SELECT id FROM conversation
          WHERE last_message_at < ${cutoff.toISOString()}::timestamptz
          ORDER BY last_message_at
          LIMIT ${batchSize}
       )
    `);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

/** Gunluk temizlikte digerlerinden yalitilir; hata yalnizca sinif + SQL koduyla loglanir. */
export async function purgeExpiredConversationsSafely(
  db: Database,
  now: Date = new Date(),
): Promise<ConversationPurgeResult & { failed: string | null }> {
  try {
    return { ...(await purgeExpiredConversations(db, now)), failed: null };
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
      (error as { code?: string })?.code ??
      "error";
    console.warn(
      "[sohbet] retention purge failed",
      error instanceof Error ? error.name : "unknown",
      code,
    );
    return { deleted: 0, truncated: false, failed: /^[0-9A-Z]{5}$/.test(code) ? code : "error" };
  }
}

// ---------------------------------------------------------------------------
// Sonuc geri bildirimi (0055)
// ---------------------------------------------------------------------------

function isMissingTable(error: unknown): boolean {
  const code =
    (error as { cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  return code === "42P01";
}

export type ResultFeedbackStatus = "saved" | "not_found" | "invalid";

/**
 * "Bu yardimci oldu mu?" oyu. Sahiplik sorguda: yalnizca kullanicinin kendi
 * sohbetindeki bir ARAMA mesajina oy verilebilir. Mesaj basina tek oy, degistirilebilir.
 */
export async function setResultFeedback(
  db: Database,
  input: { userId: number; conversationId: string; messageSeq: number; helpful: boolean },
): Promise<ResultFeedbackStatus> {
  if (!isUuid(input.conversationId)) return "not_found";
  if (!Number.isInteger(input.messageSeq) || input.messageSeq < 1) return "invalid";
  if (typeof input.helpful !== "boolean") return "invalid";
  const [message] = await db
    .select({ id: chatMessage.id, role: chatMessage.role, kind: chatMessage.kind })
    .from(chatMessage)
    .innerJoin(conversation, eq(conversation.id, chatMessage.conversationId))
    .where(
      and(
        eq(chatMessage.conversationId, input.conversationId),
        eq(chatMessage.seq, input.messageSeq),
        eq(conversation.userId, input.userId),
      ),
    );
  if (!message) return "not_found";
  if (message.role !== "assistant" || message.kind !== "search") return "invalid";
  try {
    await db
      .insert(chatResultFeedback)
      .values({
        messageId: message.id,
        conversationId: input.conversationId,
        helpful: input.helpful,
      })
      .onConflictDoUpdate({
        target: chatResultFeedback.messageId,
        set: { helpful: input.helpful, updatedAt: sql`now()` },
      });
  } catch (error) {
    // Tablo yok (0055 bekliyor): oy kaydedilemedi, arayuz "kaydedemedim" der.
    if (isMissingTable(error)) return "invalid";
    throw error;
  }
  return "saved";
}
