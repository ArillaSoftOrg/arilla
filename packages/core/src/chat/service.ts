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
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { LlmErrorCode } from "../llm/client.ts";
import { llmCallCostMicros } from "../llm/pricing.ts";
import {
  type ProviderBudgetHooks,
  type ProviderBudgetReservation,
  reserveProviderBudget,
  settleProviderBudget,
} from "../quota/provider-budget.ts";
import {
  consumeQuota,
  type QuotaConsumer,
  type QuotaReleaser,
  releaseQuota,
} from "../quota/redis-windows.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { loadLexiconCached } from "../search/lexicon-cache.ts";
import { providerCallsToday } from "../search/query-interpretation.ts";
import {
  CHAT_CLIENT_OPTIONS,
  CHAT_DAILY_CALL_CAP,
  CHAT_LEASE_SECONDS,
  CHAT_RETENTION_DAYS,
  CHAT_TURN_OPERATION,
  chatMessageLimits,
  chatTurnsPerHour,
  isChatImageEnabled,
  isChatLinkEnabled,
  MAX_USER_MESSAGES_PER_CONVERSATION,
  USER_MESSAGE_MAX,
} from "./config.ts";
import {
  type ClarifyQuestion,
  cleanText,
  parseClarifyQuestion,
  type SearchIntent,
} from "./contract.ts";
import { validateChatFeedback } from "./feedback.ts";
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
import { type ChatLinkPayload, parseChatLinkPayload } from "./link.ts";
import { planLinkTurn } from "./link-turn.ts";
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
      /** Karar 0090: link mesajinin yuku (`payload.link`); yalnizca link `notice`larinda. */
      link?: ChatLinkPayload;
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
    };
  }
  const link = row.kind === "notice" ? parseChatLinkPayload(payload?.link) : null;
  return {
    id: row.id,
    seq: row.seq,
    role: "assistant",
    kind: row.kind === "notice" ? "notice" : "search",
    content: row.content,
    intent: parseStoredIntent(payload?.intent),
    source: sourceOf(payload),
    helpful,
    ...(link ? { link } : {}),
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
  | { status: "invalid_input" }
  | { status: "invalid_option" }
  | { status: "not_found" };

function cleanUserText(value: unknown): string | null {
  return cleanText(value, USER_MESSAGE_MAX);
}

function requestKeyOrNull(value: string | undefined): string | null {
  return value !== undefined && value.length >= 8 && value.length <= 100 ? value : null;
}

/** Kullanicinin son bir saatteki mesaj sayisi (tum sohbetler). Redis yokken yedek tavan. */
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

/** Testler icin enjekte edilebilir kota islevleri; varsayilan Redis. */
export interface ChatQuotaOptions {
  consume?: QuotaConsumer;
  release?: QuotaReleaser;
}

/**
 * Bir kullanici mesaji = `chat_message` havuzundan 1 (`quota/policy.ts`, saat/
 * gun/hafta/ay). Yalnizca mesaj GERCEKTEN yazilacaksa cagrilir (tekrar,
 * mesgul, dolu, gecersiz girdi harcamaz). Redis erisilemezse bugunku DB
 * saatlik sayimina duser: sohbet kesilmez, tavan yine uygulanir.
 * `consumed`: yazma basarisiz olursa geri verilecek bir Redis harcamasi var mi.
 */
async function consumeChatMessageQuota(
  db: Executor,
  userId: number,
  options: ChatQuotaOptions,
): Promise<{ allowed: boolean; consumed: boolean }> {
  try {
    const result = await (options.consume ?? consumeQuota)({
      pool: "chat_message",
      subject: `user:${userId}`,
      limits: chatMessageLimits(),
    });
    return { allowed: result.allowed, consumed: result.allowed };
  } catch (error) {
    if (!isRedisUnavailableError(error)) throw error;
    console.error("[chat] message quota store unavailable; hourly db cap applies");
    return {
      allowed: (await recentUserMessageCount(db, userId)) < chatTurnsPerHour(),
      consumed: false,
    };
  }
}

async function releaseChatMessageQuota(userId: number, options: ChatQuotaOptions): Promise<void> {
  try {
    await (options.release ?? releaseQuota)({ pool: "chat_message", subject: `user:${userId}` });
  } catch {
    // Iade edilemezse kullanici bir mesaj hakki kaybeder; yazma hatasi zaten donuyor.
  }
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
  quotaOptions: ChatQuotaOptions = {},
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
  const quota = await consumeChatMessageQuota(db, input.userId, quotaOptions);
  if (!quota.allowed) return { status: "rate_limited" };
  try {
    return await insertConversation(db, input, text, requestKey, attachment);
  } catch (error) {
    if (quota.consumed) await releaseChatMessageQuota(input.userId, quotaOptions);
    throw error;
  }
}

function insertConversation(
  db: Database,
  input: { userId: number },
  text: string | null,
  requestKey: string | null,
  attachment: ChatAttachmentInput | undefined,
): Promise<CreateConversationResult> {
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
  },
  quotaOptions: ChatQuotaOptions = {},
): Promise<SubmitMessageResult> {
  if (!isUuid(input.conversationId)) return { status: "not_found" };
  const requestKey = requestKeyOrNull(input.requestKey);

  // Kota mesaj yazilacagi kesinlesince (islem icinde, tum kontrollerden sonra)
  // harcanir; yazma basarisiz olursa geri verilir.
  let consumed = false;
  try {
    return await db.transaction(
      async (tx): Promise<SubmitMessageResult> =>
        submitInTx(tx, input, requestKey, quotaOptions, () => {
          consumed = true;
        }),
    );
  } catch (error) {
    if (consumed) await releaseChatMessageQuota(input.userId, quotaOptions);
    throw error;
  }
}

async function submitInTx(
  tx: Tx,
  input: { userId: number; conversationId: string; request: ChatInputRequest },
  requestKey: string | null,
  quotaOptions: ChatQuotaOptions,
  onConsumed: () => void,
): Promise<SubmitMessageResult> {
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

  const pending = parseClarifyQuestion(row.pendingQuestion);
  let kind: "text" | "option" | "skip";
  let content: string;
  let payload: Record<string, unknown> | null = null;
  const request = input.request;
  if (request.kind === "text") {
    const text = cleanUserText(request.text);
    if (text === null) return { status: "invalid_input" };
    kind = "text";
    content = text;
    if (pending) payload = { answersQuestion: pending.id };
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

  const quota = await consumeChatMessageQuota(tx, input.userId, quotaOptions);
  if (!quota.allowed) return { status: "rate_limited" };
  if (quota.consumed) onConsumed();

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
  const messages: TranscriptMessage[] = view.messages.map((message) => ({
    role: message.role,
    kind: message.kind,
    text: transcriptText(message),
    ...(message.role === "user" && message.attachmentId ? { hasImage: true } : {}),
  }));
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
 * Karar 0078: modele giden baglam penceresindeki ilk gorselli kullanici mesajinin
 * gorseli. Pencere disina cikarsa artik eklenmez.
 */
async function loadContextImage(
  db: Executor,
  userId: number,
  messages: readonly ChatMessageView[],
): Promise<ChatImageInput | null> {
  if (!isChatImageEnabled()) return null;
  const owner = messages
    .slice(-CHAT_CONTEXT_MESSAGES)
    .find((message) => message.role === "user" && message.attachmentId);
  if (owner?.role !== "user" || !owner.attachmentId) return null;
  try {
    const loaded = await loadChatAttachment(db, { userId, attachmentId: owner.attachmentId });
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
  /** Testler icin; varsayilan atomik Redis saglayici butcesi. */
  budget?: ProviderBudgetHooks;
}

interface ChatProviderBudget {
  modelAllowed: boolean;
  /** Redis ayirmasi; yedek DB sayiminda `null` (kesinlestirilecek bir sey yok). */
  reservation: ProviderBudgetReservation | null;
}

/**
 * Gunluk saglayici tavani (`CHAT_DAILY_CALL_CAP`, tum kullanicilar): bir turun
 * en fazla deneme sayisi kadar (`CHAT_CLIENT_OPTIONS.maxAttempts`) Redis'te
 * atomik ayrilir; model cagrisindan sonra gercek deneme sayisina cekilir.
 * Redis erisilemezse eski davranis: `api_usage` gunluk sayimi (sinirli,
 * esanlilikta az tasabilir); sohbet kesilmez, tavan dolunca yedek cevap.
 */
async function chatProviderBudget(
  db: Database,
  hooks: ProviderBudgetHooks | undefined,
): Promise<ChatProviderBudget> {
  try {
    const budget = await (hooks?.reserve ?? reserveProviderBudget)({
      operation: CHAT_TURN_OPERATION,
      amount: CHAT_CLIENT_OPTIONS.maxAttempts,
      cap: CHAT_DAILY_CALL_CAP,
    });
    return budget.allowed
      ? { modelAllowed: true, reservation: budget.reservation }
      : { modelAllowed: false, reservation: null };
  } catch (error) {
    if (!isRedisUnavailableError(error)) throw error;
    console.error("[chat] provider budget store unavailable; daily db count applies");
    const callsToday = await providerCallsToday(db, new Date(), CHAT_TURN_OPERATION);
    return { modelAllowed: callsToday < CHAT_DAILY_CALL_CAP, reservation: null };
  }
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

  // Saglayici butcesi: ayrildiysa tur bitmeden MUTLAKA gercek deneme sayisina
  // cekilir (model hic cagrilmadiysa 0 = tam iade). `null` = bilinmiyor
  // (beklenmeyen hata): ayirma oldugu gibi kalir, eksik sayilmaz.
  let budget: ChatProviderBudget | null = null;
  let attempts: number | null = 0;
  let settled = false;
  const settleBudget = async () => {
    if (settled || !budget?.reservation || attempts === null) return;
    settled = true;
    await (input.budget?.settle ?? settleProviderBudget)(budget.reservation, attempts).catch(() =>
      console.error("[chat] provider budget settle failed"),
    );
  };

  try {
    // Birbirine bagimli degil, tek tur: mesajlar, gunluk tavan, sozluk isitma (aramadan once).
    const [rows, providerBudget] = await Promise.all([
      timer.time("load_context", () => loadMessageRows(db, claimed.id)),
      timer.time("provider_limit", () => chatProviderBudget(db, input.budget)),
      timer.time("lexicon", () => loadLexiconCached(db)).catch(() => undefined),
    ]);
    budget = providerBudget;
    const view = buildView(claimed, rows);

    // Karar 0090: bayrak aciksa baglanti iceren mesaj (ya da bir link referansinin
    // takibi) modele GITMEDEN burada cevaplanir; bayrak kapaliyken bu blok yoktur.
    if (isChatLinkEnabled()) {
      const lastMessage = view.messages.at(-1);
      if (lastMessage?.role === "user") {
        const plan = await timer.time("link_turn", () =>
          planLinkTurn(db, {
            userId: input.userId,
            conversationId: claimed.id,
            messages: view.messages.map((message) => ({
              role: message.role,
              kind: message.kind,
              content: message.content,
              ...(message.role === "user"
                ? { attachmentId: message.attachmentId ?? null }
                : { link: message.kind === "notice" ? (message.link ?? null) : null }),
            })),
            lastSeq: lastMessage.seq,
            modelAllowed: providerBudget.modelAllowed,
            interpreter: input.interpreter,
          }),
        );
        if (plan) return await persistLinkTurn(plan, lastMessage.seq);
      }
    }

    const image = await loadContextImage(db, input.userId, view.messages);
    const maybeRequest = toInterpretRequest(view, image);
    if (!maybeRequest) {
      await releaseLease(db, input.conversationId);
      return { status: "idle" };
    }
    const request: InterpretRequest = maybeRequest;
    const lastSeq = view.messages.at(-1)?.seq ?? 0;
    // Kilit/islem YOK: kira yalnizca bir satir isaretidir; model cagrisi DB'yi tutmaz.
    const modelAllowed = providerBudget.modelAllowed;
    attempts = null;
    const outcome = await timer.time("gemini", () =>
      interpretTurn(input.interpreter, request, { modelAllowed }),
    );
    attempts = outcome.calls.length;
    await settleBudget();

    return await persistTurn();

    /** Link turu: tek islem, model degil `api_usage` yalnizca Faz 5 cagrisi varsa. */
    function persistLinkTurn(
      plan: NonNullable<Awaited<ReturnType<typeof planLinkTurn>>>,
      answeredSeq: number,
    ): Promise<ProcessTurnResult> {
      return timer.time("persist", () =>
        db.transaction(async (tx): Promise<ProcessTurnResult> => {
          const [row] = await tx
            .select()
            .from(conversation)
            .where(eq(conversation.id, input.conversationId))
            .for("update");
          if (!row) return { status: "not_found" };
          if (plan.calls.length > 0) {
            await tx.insert(apiUsage).values(
              plan.calls.map((call) => ({
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
          // Bu arada baska bir tur cevap yazdiysa (kira dolmasi) ikinci cevap yazilmaz.
          if (row.messageCount !== answeredSeq) {
            await releaseLease(tx, row.id);
            return { status: "idle" };
          }
          const seq = row.messageCount + 1;
          await tx.insert(chatMessage).values({
            conversationId: row.id,
            seq,
            role: "assistant",
            kind: "notice",
            content: plan.content,
            payload: { link: plan.link },
          });
          await tx
            .update(conversation)
            .set({
              // Yeni link bekleyen soruyu cevaplanmis sayar; takip turu soruya dokunmaz.
              ...(plan.kind === "refinement" ? {} : { pendingQuestion: null }),
              messageCount: seq,
              processingUntil: null,
              lastMessageAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(conversation.id, row.id));
          setPreview({ seq, kind: "search", content: plan.content });
          return { status: "answered", source: "fallback", action: "search" };
        }),
      );
    }

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
                // Karar 0082: tahmini liste fiyati; bilinmeyen 0 = "fiyatlanmamis".
                costMicros: llmCallCostMicros(call),
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

          const seq = row.messageCount + 1;
          if (turn.action === "clarify") {
            await tx.insert(chatMessage).values({
              conversationId: row.id,
              seq,
              role: "assistant",
              kind: "clarify",
              content: turn.message,
              payload: { question: turn.question, source },
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
            payload: { intent: merged, source, fallbackReason: outcome.fallbackReason },
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
  } finally {
    await settleBudget();
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

export type ResultFeedbackStatus = "saved" | "not_found" | "invalid" | "unavailable";

/** Oy anindaki model surumu icin aranan pencere (api_usage mesaja bagli degil; yaklasik). */
const FEEDBACK_MODEL_LOOKBACK_MS = 10 * 60 * 1000;

function isMissingColumn(error: unknown): boolean {
  const code =
    (error as { cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  return code === "42703";
}

/**
 * "Bu yardimci oldu mu?" oyu (karar 0075, 0079). Sahiplik sorguda: yalnizca kullanicinin
 * kendi sohbetindeki bir ARAMA mesajina oy verilebilir. Mesaj basina tek oy, degistirilebilir;
 * ayni icerikle tekrar `updated_at`i oynatmaz. Olumsuz oy istege bagli neden/yorum tasir.
 */
export async function setResultFeedback(
  db: Database,
  input: {
    userId: number;
    conversationId: string;
    messageSeq: number;
    helpful: boolean;
    reasons?: readonly string[];
    comment?: string | null;
  },
): Promise<ResultFeedbackStatus> {
  if (!isUuid(input.conversationId)) return "not_found";
  if (!Number.isInteger(input.messageSeq) || input.messageSeq < 1) return "invalid";
  const details = validateChatFeedback(input);
  if (!details.ok) return "invalid";
  const [message] = await db
    .select({
      id: chatMessage.id,
      role: chatMessage.role,
      kind: chatMessage.kind,
      createdAt: chatMessage.createdAt,
    })
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
    try {
      const [usage] = await db
        .select({ modelVersion: apiUsage.modelVersion })
        .from(apiUsage)
        .where(
          and(
            eq(apiUsage.operation, CHAT_TURN_OPERATION),
            eq(apiUsage.userId, input.userId),
            lte(apiUsage.createdAt, message.createdAt),
            gte(
              apiUsage.createdAt,
              new Date(message.createdAt.getTime() - FEEDBACK_MODEL_LOOKBACK_MS),
            ),
          ),
        )
        .orderBy(desc(apiUsage.createdAt))
        .limit(1);
      await db
        .insert(chatResultFeedback)
        .values({
          messageId: message.id,
          conversationId: input.conversationId,
          helpful: input.helpful,
          reasons: details.reasons,
          comment: details.comment,
          modelVersion: usage?.modelVersion ?? null,
        })
        .onConflictDoUpdate({
          target: chatResultFeedback.messageId,
          set: {
            helpful: input.helpful,
            reasons: details.reasons,
            comment: details.comment,
            updatedAt: sql`now()`,
          },
          // Ayni icerikle tekrar: satir degismez (idempotent).
          setWhere: sql`${chatResultFeedback.helpful} IS DISTINCT FROM ${input.helpful}
            OR ${chatResultFeedback.reasons} IS DISTINCT FROM ${sql.raw("EXCLUDED.reasons")}
            OR ${chatResultFeedback.comment} IS DISTINCT FROM ${sql.raw("EXCLUDED.comment")}`,
        });
    } catch (error) {
      // 0058 henuz uygulanmamis: yalniz evet/hayir yazilabilir. Neden/yorum varsa "saved"
      // DONME (kullanici yorumunun kaydoldugunu sanirdi): "unavailable", modal acik kalir.
      if (!isMissingColumn(error)) throw error;
      if (details.reasons.length > 0 || details.comment !== null) return "unavailable";
      // Ham SQL: Drizzle insert'i semadaki TUM kolonlari adlandirir, 0058 oncesi yine 42703 verirdi.
      await db.execute(sql`
        INSERT INTO chat_result_feedback (message_id, conversation_id, helpful)
        VALUES (${message.id}, ${input.conversationId}::uuid, ${input.helpful})
        ON CONFLICT (message_id) DO UPDATE SET helpful = EXCLUDED.helpful, updated_at = now()`);
    }
  } catch (error) {
    // Tablo yok (0055 bekliyor): oy kaydedilemedi, arayuz "kaydedemedim" der.
    if (isMissingTable(error)) return "invalid";
    throw error;
  }
  return "saved";
}
