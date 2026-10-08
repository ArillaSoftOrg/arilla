/**
 * Yonetim: AI sohbet geri bildirimi (`/yonetim/ai-geri-bildirim`, karar 0079).
 *
 * Kaynak yalnizca `chat_result_feedback` + `chat_message` (+ `conversation` sayim icin).
 * Sohbet METNI okunmaz ve donmez; yalnizca oy, neden, yorum, mesaj referansi, arama
 * kaynagi (`payload.source`, `payload.fallbackReason`) ve yaklasik model surumu.
 * Kullanici adi/e-posta da donmez. Sohbet baglami ayri bir faz ve ayri yetkidir.
 *
 * Her goruntuleme `admin_audit_event`'e yazilir (yalniz filtre ADLARI ve sayilar).
 * Gunler Europe/Istanbul; tum sorgular salt okunur islemde ve zaman asimlidir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { CHAT_FEEDBACK_REASONS, type ChatFeedbackReason } from "../chat/feedback.ts";
import { recordAdminEvent } from "./audit.ts";
import { isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const CHAT_FEEDBACK_PAGE_SIZE = 25;
export const CHAT_FEEDBACK_TREND_DAYS = 30;
const QUERY_TIMEOUT_MS = 8_000;
const TIME_ZONE = "Europe/Istanbul";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 0058 (kolonlar) ya da 0055 (tablo) henuz uygulanmamis bir veritabaninda yonetim sayfasi
 * 500 yerine aciklayici bir not gosterir: kod migration'dan once dagitilirsa kirilmaz.
 */
export function isChatFeedbackSchemaMissing(error: unknown): boolean {
  const code =
    (error as { cause?: { code?: string } } | null)?.cause?.code ??
    (error as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01";
}

export function isChatFeedbackReason(value: unknown): value is ChatFeedbackReason {
  return typeof value === "string" && (CHAT_FEEDBACK_REASONS as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` ve gercek bir takvim gunu mu (2026-02-31 reddedilir). */
export function isChatFeedbackDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export interface ChatFeedbackFilter {
  /** Istanbul gunu, dahil. Varsayilan: bugunden 29 gun once. */
  from?: string;
  /** Istanbul gunu, dahil. Varsayilan: bugun. */
  to?: string;
  helpful?: boolean;
  reason?: ChatFeedbackReason;
  hasComment?: boolean;
  /** Bu `message_id`'den KUCUK olanlar (daha eski sayfa). */
  beforeId?: number;
}

function filterNames(filter: ChatFeedbackFilter): string[] {
  return [
    filter.from ? "from" : null,
    filter.to ? "to" : null,
    filter.helpful !== undefined ? "helpful" : null,
    filter.reason ? "reason" : null,
    filter.hasComment ? "has_comment" : null,
    filter.beforeId ? "page" : null,
  ].filter((name): name is string => name !== null);
}

export interface ChatFeedbackTotals {
  total: number;
  positive: number;
  negative: number;
  /** 0..1; oy yoksa null (0/0 gostermeyiz). */
  positiveRate: number | null;
  withComment: number;
}

export interface ChatFeedbackWindow extends ChatFeedbackTotals {
  days: number;
}

export interface ChatFeedbackDay {
  /** Istanbul gunu, YYYY-MM-DD. */
  day: string;
  positive: number;
  negative: number;
}

export interface ChatFeedbackReasonCount {
  reason: string;
  count: number;
}

export interface ChatFeedbackModelRow extends ChatFeedbackTotals {
  /** NULL: oy anindaki model surumu bulunamadi. */
  modelVersion: string | null;
}

export interface ChatFeedbackSummary {
  /** Filtre araligi (tarih), oy yonu/neden/yorum filtresinden bagimsiz toplamlar. */
  range: { from: string; to: string };
  totals: ChatFeedbackTotals;
  /**
   * Katilim: aralikta olusan oylanabilir yanit (asistan `search`) sayisi ve bunlardan oy
   * alanlar. Arayuz yalnizca son sonuc bloklarinda oy sordugu icin ORAN ALT SINIR
   * GOSTERGESIDIR; "oy verme egilimi" olarak okunmali.
   */
  participation: { votable: number; voted: number; rate: number | null };
  /** Son 7 / 30 gun (aralik filtresinden bagimsiz, bugune gore). */
  last7: ChatFeedbackWindow;
  last30: ChatFeedbackWindow;
  /** Son 30 gun, bos gunler dahil, eskiden yeniye. */
  daily: ChatFeedbackDay[];
  /** Yalniz olumsuz oylar; neden secilmeyenler `none` altinda. */
  reasons: ChatFeedbackReasonCount[];
  models: ChatFeedbackModelRow[];
}

export interface ChatFeedbackListRow {
  messageId: number;
  conversationId: string;
  messageSeq: number;
  helpful: boolean;
  reasons: string[];
  comment: string | null;
  modelVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatFeedbackPage {
  rows: ChatFeedbackListRow[];
  nextBeforeId: number | null;
}

export interface ChatFeedbackDetail extends ChatFeedbackListRow {
  /** `payload.source`: modelden mi, deterministik yedekten mi geldi. */
  searchSource: string | null;
  fallbackReason: string | null;
}

type SqlRow = Record<string, unknown>;

function num(value: unknown): number {
  return Number(value ?? 0);
}

function totalsOf(row: SqlRow | undefined): ChatFeedbackTotals {
  const total = num(row?.total);
  const positive = num(row?.positive);
  return {
    total,
    positive,
    negative: total - positive,
    positiveRate: total > 0 ? positive / total : null,
    withComment: num(row?.with_comment),
  };
}

/** Istanbul'daki bugunun `YYYY-MM-DD`'si ve `n` gun oncesi. */
function istanbulDay(now: Date, minusDays = 0): string {
  const shifted = new Date(now.getTime() - minusDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(shifted);
}

function resolveRange(filter: ChatFeedbackFilter, now: Date): { from: string; to: string } {
  const today = istanbulDay(now);
  const to = filter.to && isChatFeedbackDay(filter.to) ? filter.to : today;
  const defaultFrom = istanbulDay(new Date(`${to}T12:00:00Z`), CHAT_FEEDBACK_TREND_DAYS - 1);
  let from = filter.from && isChatFeedbackDay(filter.from) ? filter.from : defaultFrom;
  if (from > to) from = to;
  return { from, to };
}

/** `[from 00:00, to+1 00:00)` Istanbul zamaninda yari acik aralik. */
function rangeBounds(range: { from: string; to: string }) {
  return {
    start: sql`(${range.from}::date)::timestamp AT TIME ZONE ${TIME_ZONE}`,
    end: sql`((${range.to}::date) + 1)::timestamp AT TIME ZONE ${TIME_ZONE}`,
  };
}

/**
 * Ozet + egilim. Tek goruntuleme = tek `chat_feedback.list_view` denetim kaydi
 * (liste sayfasi bunu `listChatFeedback` ile BIRLIKTE cagirir; denetim orada yazilir).
 */
export async function getChatFeedbackSummary(
  db: Database,
  actor: AdminActor,
  filter: ChatFeedbackFilter = {},
  now: Date = new Date(),
): Promise<ChatFeedbackSummary> {
  assertCapability(actor, "feedback.chat.read");
  const range = resolveRange(filter, now);
  const { start, end } = rangeBounds(range);
  const trendFrom = istanbulDay(now, CHAT_FEEDBACK_TREND_DAYS - 1);
  const today = istanbulDay(now);

  return readOnly(db, QUERY_TIMEOUT_MS, async (tx) => {
    const aggregate = (since: ReturnType<typeof sql> | null, until: ReturnType<typeof sql>) =>
      tx.execute(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE helpful)::int AS positive,
               count(*) FILTER (WHERE comment IS NOT NULL)::int AS with_comment
          FROM chat_result_feedback
         WHERE ${since ? sql`created_at >= ${since} AND` : sql``} created_at < ${until}`);

    const [totalsRes, partRes, last7Res, last30Res, dailyRes, reasonRes, modelRes] =
      await Promise.all([
        aggregate(start, end),
        tx.execute(sql`
          SELECT count(*)::int AS votable,
                 count(f.message_id)::int AS voted
            FROM chat_message m
            LEFT JOIN chat_result_feedback f ON f.message_id = m.id
           WHERE m.role = 'assistant' AND m.kind = 'search'
             AND m.created_at >= ${start} AND m.created_at < ${end}`),
        aggregate(
          sql`((${today}::date) - 6)::timestamp AT TIME ZONE ${TIME_ZONE}`,
          sql`((${today}::date) + 1)::timestamp AT TIME ZONE ${TIME_ZONE}`,
        ),
        aggregate(
          sql`(${trendFrom}::date)::timestamp AT TIME ZONE ${TIME_ZONE}`,
          sql`((${today}::date) + 1)::timestamp AT TIME ZONE ${TIME_ZONE}`,
        ),
        tx.execute(sql`
          SELECT to_char(g.day, 'YYYY-MM-DD') AS day,
                 count(f.message_id) FILTER (WHERE f.helpful)::int AS positive,
                 count(f.message_id) FILTER (WHERE NOT f.helpful)::int AS negative
            FROM generate_series(${trendFrom}::timestamp, ${today}::timestamp, interval '1 day') AS g(day)
            LEFT JOIN chat_result_feedback f
              ON (f.created_at AT TIME ZONE ${TIME_ZONE})::date = g.day::date
           GROUP BY g.day ORDER BY g.day`),
        tx.execute(sql`
          SELECT COALESCE(r.reason, 'none') AS reason, count(*)::int AS n
            FROM chat_result_feedback f
            LEFT JOIN LATERAL unnest(NULLIF(f.reasons, '{}'::text[])) AS r(reason) ON TRUE
           WHERE NOT f.helpful AND f.created_at >= ${start} AND f.created_at < ${end}
           GROUP BY 1 ORDER BY n DESC, reason`),
        tx.execute(sql`
          SELECT model_version,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE helpful)::int AS positive,
                 count(*) FILTER (WHERE comment IS NOT NULL)::int AS with_comment
            FROM chat_result_feedback
           WHERE created_at >= ${start} AND created_at < ${end}
           GROUP BY model_version ORDER BY total DESC, model_version NULLS LAST`),
      ]);

    const votable = num(partRes.rows[0]?.votable);
    const voted = num(partRes.rows[0]?.voted);
    return {
      range,
      totals: totalsOf(totalsRes.rows[0]),
      participation: { votable, voted, rate: votable > 0 ? voted / votable : null },
      last7: { days: 7, ...totalsOf(last7Res.rows[0]) },
      last30: { days: CHAT_FEEDBACK_TREND_DAYS, ...totalsOf(last30Res.rows[0]) },
      daily: dailyRes.rows.map((row) => ({
        day: String(row.day),
        positive: num(row.positive),
        negative: num(row.negative),
      })),
      reasons: reasonRes.rows.map((row) => ({ reason: String(row.reason), count: num(row.n) })),
      models: modelRes.rows.map((row) => ({
        modelVersion: (row.model_version as string | null) ?? null,
        ...totalsOf(row),
      })),
    };
  });
}

/** Filtreli liste, yeniden eskiye (`message_id` imleci). Goruntuleme denetime yazilir. */
export async function listChatFeedback(
  db: Database,
  actor: AdminActor,
  filter: ChatFeedbackFilter = {},
  now: Date = new Date(),
): Promise<ChatFeedbackPage> {
  assertCapability(actor, "feedback.chat.read");
  const range = resolveRange(filter, now);
  const { start, end } = rangeBounds(range);
  const size = CHAT_FEEDBACK_PAGE_SIZE;

  const conditions = [sql`f.created_at >= ${start}`, sql`f.created_at < ${end}`];
  if (filter.helpful !== undefined) conditions.push(sql`f.helpful = ${filter.helpful}`);
  if (filter.reason) {
    // Parametre diziye cevrilir; kod izin listesinden gelir (isChatFeedbackReason).
    conditions.push(sql`${filter.reason} = ANY(f.reasons)`);
  }
  if (filter.hasComment) conditions.push(sql`f.comment IS NOT NULL`);
  if (filter.beforeId !== undefined && isPositiveId(filter.beforeId)) {
    conditions.push(sql`f.message_id < ${filter.beforeId}`);
  }
  const where = sql.join(conditions, sql` AND `);

  const result = await readOnly(db, QUERY_TIMEOUT_MS, (tx) =>
    tx.execute(sql`
      SELECT f.message_id, f.conversation_id, m.seq AS message_seq, f.helpful, f.reasons,
             f.comment, f.model_version, f.created_at, f.updated_at
        FROM chat_result_feedback f
        JOIN chat_message m ON m.id = f.message_id
       WHERE ${where}
       ORDER BY f.message_id DESC
       LIMIT ${size + 1}`),
  );

  const mapped = result.rows.map(toListRow);
  const hasMore = mapped.length > size;
  const rows = hasMore ? mapped.slice(0, size) : mapped;

  await recordAdminEvent(db, {
    actor,
    action: "chat_feedback.list_view",
    targetType: "chat_feedback",
    targetId: "-",
    after: { filters: filterNames(filter), results: rows.length },
  });

  return { rows, nextBeforeId: hasMore ? (rows[rows.length - 1]?.messageId ?? null) : null };
}

function toListRow(row: SqlRow): ChatFeedbackListRow {
  return {
    messageId: num(row.message_id),
    conversationId: String(row.conversation_id),
    messageSeq: num(row.message_seq),
    helpful: Boolean(row.helpful),
    reasons: (row.reasons as string[] | null) ?? [],
    comment: (row.comment as string | null) ?? null,
    modelVersion: (row.model_version as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

/**
 * Tek oy. Sohbet metni YOK: yalnizca arama kaynagi (`model`/`fallback`) ve yedek nedeni
 * (`payload` icindeki serbest metin olmayan iki alan). Goruntuleme denetime yazilir.
 */
export async function getChatFeedbackDetail(
  db: Database,
  actor: AdminActor,
  messageId: number,
): Promise<ChatFeedbackDetail | null> {
  assertCapability(actor, "feedback.chat.read");
  if (!isPositiveId(messageId)) return null;
  const result = await readOnly(db, QUERY_TIMEOUT_MS, (tx) =>
    tx.execute(sql`
      SELECT f.message_id, f.conversation_id, m.seq AS message_seq, f.helpful, f.reasons,
             f.comment, f.model_version, f.created_at, f.updated_at,
             m.payload->>'source' AS search_source,
             m.payload->>'fallbackReason' AS fallback_reason
        FROM chat_result_feedback f
        JOIN chat_message m ON m.id = f.message_id
       WHERE f.message_id = ${messageId}`),
  );
  const row = result.rows[0];
  if (!row) return null;

  await recordAdminEvent(db, {
    actor,
    action: "chat_feedback.view",
    targetType: "chat_feedback",
    targetId: messageId,
  });

  return {
    ...toListRow(row),
    searchSource: (row.search_source as string | null) ?? null,
    fallbackReason: (row.fallback_reason as string | null) ?? null,
  };
}
