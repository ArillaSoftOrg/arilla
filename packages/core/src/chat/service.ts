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
import { apiUsage, chatMessage, conversation, type Database } from "@arilla/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { LlmErrorCode } from "../llm/client.ts";
import { providerCallsToday } from "../search/query-interpretation.ts";
import {
  CHAT_DAILY_CALL_CAP,
  CHAT_LEASE_SECONDS,
  CHAT_RETENTION_DAYS,
  CHAT_TURN_OPERATION,
  chatTurnsPerHour,
  MAX_USER_MESSAGES_PER_CONVERSATION,
  USER_MESSAGE_MAX,
} from "./config.ts";
import {
  type ClarifyQuestion,
  cleanText,
  parseClarifyQuestion,
  type SearchIntent,
} from "./contract.ts";
import { mergeSearchIntent, parseStoredIntent } from "./intent.ts";
import {
  type ChatInterpreter,
  fallbackTurn,
  type InterpretRequest,
  interpretTurn,
  type TranscriptMessage,
  type UserInput,
} from "./interpreter.ts";

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

function sourceOf(payload: Record<string, unknown> | null): "model" | "fallback" | null {
  const source = payload?.source;
  return source === "model" || source === "fallback" ? source : null;
}

function toView(row: typeof chatMessage.$inferSelect): ChatMessageView {
  const payload = row.payload;
  if (row.role === "user") {
    return {
      id: row.id,
      seq: row.seq,
      role: "user",
      kind: row.kind === "option" || row.kind === "skip" ? row.kind : "text",
      content: row.content,
      value: typeof payload?.value === "string" ? payload.value : null,
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
  return {
    id: row.id,
    seq: row.seq,
    role: "assistant",
    kind: row.kind === "notice" ? "notice" : "search",
    content: row.content,
    intent: parseStoredIntent(payload?.intent),
    source: sourceOf(payload),
  };
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
  const rows = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, row.id))
    .orderBy(asc(chatMessage.seq));
  const messages = rows.map(toView);
  return {
    id: row.id,
    title: row.title,
    currentIntent: parseStoredIntent(row.currentSearchIntent),
    pendingQuestion: parseClarifyQuestion(row.pendingQuestion),
    awaitingReply: messages.at(-1)?.role === "user",
    messages,
  };
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

export async function createConversation(
  db: Database,
  input: { userId: number; message: string; requestKey?: string },
): Promise<CreateConversationResult> {
  const text = cleanUserText(input.message);
  if (text === null) return { status: "invalid_input" };
  if ((await recentUserMessageCount(db, input.userId)) >= chatTurnsPerHour()) {
    return { status: "rate_limited" };
  }
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(conversation)
      .values({ userId: input.userId, title: text.slice(0, 80), messageCount: 1 })
      .returning({ id: conversation.id });
    if (!created) throw new Error("conversation insert returned no row");
    await tx.insert(chatMessage).values({
      conversationId: created.id,
      seq: 1,
      role: "user",
      kind: "text",
      content: text,
      clientRequestId: requestKeyOrNull(input.requestKey),
    });
    return { status: "created", conversationId: created.id } as const;
  });
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
): Promise<SubmitMessageResult> {
  if (!isUuid(input.conversationId)) return { status: "not_found" };
  const requestKey = requestKeyOrNull(input.requestKey);

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

function toInterpretRequest(view: ConversationView): InterpretRequest | null {
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
  }));
  return {
    messages,
    currentIntent: view.currentIntent,
    pendingQuestion: pending ? { id: pending.id, title: pending.title } : null,
    clarifyCount: countTrailingClarifications(view.messages),
    input,
  };
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
  input: {
    userId: number;
    conversationId: string;
    interpreter: ChatInterpreter;
    leaseSeconds?: number;
  },
): Promise<ProcessTurnResult> {
  if (!isUuid(input.conversationId)) return { status: "not_found" };
  const lease = input.leaseSeconds ?? CHAT_LEASE_SECONDS;

  // Atomik kira: ayni anda tek tur. Sure dolmus kira (cokmus is) yeniden alinabilir.
  const acquired = await db
    .update(conversation)
    .set({ processingUntil: sql`now() + make_interval(secs => ${lease})` })
    .where(
      and(
        eq(conversation.id, input.conversationId),
        eq(conversation.userId, input.userId),
        or(isNull(conversation.processingUntil), lt(conversation.processingUntil, sql`now()`)),
      ),
    )
    .returning({ id: conversation.id });
  if (acquired.length === 0) {
    const [exists] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.userId, input.userId)));
    return exists ? { status: "busy" } : { status: "not_found" };
  }

  try {
    const view = await loadConversation(db, {
      userId: input.userId,
      conversationId: input.conversationId,
    });
    const request = view ? toInterpretRequest(view) : null;
    if (!view || !request) {
      await releaseLease(db, input.conversationId);
      return { status: "idle" };
    }
    const lastSeq = view.messages.at(-1)?.seq ?? 0;
    // Kilit/islem YOK: kira yalnizca bir satir isaretidir; model cagrisi DB'yi tutmaz.
    const modelAllowed =
      (await providerCallsToday(db, new Date(), CHAT_TURN_OPERATION)) < CHAT_DAILY_CALL_CAP;
    const outcome = await interpretTurn(input.interpreter, request, { modelAllowed });

    return await db.transaction(async (tx): Promise<ProcessTurnResult> => {
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
            turn.action === "search" ? mergeSearchIntent(view.currentIntent, turn.intent) : null;
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
      return { status: "answered", source, action: "search" };
    });
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
