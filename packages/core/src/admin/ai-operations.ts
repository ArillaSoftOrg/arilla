/**
 * `/yonetim/ai` (karar 0085): model işlemlerinin işletim görünümü.
 *
 * Kaynaklar ve sınırlar:
 * - `api_usage`: işlem × model, çağrı, önbellek isabeti, token (`units`,
 *   girdi/çıktı ayrımı saklanmaz), TAHMİNİ maliyet (karar 0082) ve
 *   fiyatlanmamış çağrı. Kullanıcıya göre GRUPLANMAZ: kullanıcı başına AI
 *   maliyeti bu ekranda yoktur.
 * - Sağlayıcı günlük tavanları: koddaki sabitler + bugünkü `api_usage` sayımı.
 * - Arama hakkı (PostgreSQL kotası): `ai_search_charge` durumları ve bugünün
 *   `ai_quota_day` doluluğu — yalnızca toplam sayılar.
 * - Sorgu yorumu: `query_interpretation` durum dağılımı.
 * - Sohbet: konuşma ve mesaj SAYILARI; mesaj içeriği hiç seçilmez.
 * - Gecikme, hata oranı ve Redis kota reddi saklanmıyor: ekran bunları
 *   "ölçülmüyor" diye etiketler (Faz E).
 *
 * Her sorgu salt okunur işlemde, zaman aşımlı ve pencere ile sınırlıdır.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { CHAT_DAILY_CALL_CAP, CHAT_TURN_OPERATION } from "../chat/config.ts";
import { QUOTA_POLICY } from "../quota/policy.ts";
import { SEARCH_QUALITY_TIME_ZONE } from "../search/quality.ts";
import {
  QUERY_INTERPRETATION_DAILY_CALL_CAP,
  QUERY_INTERPRETATION_OPERATION,
} from "../search/query-interpretation.ts";
import {
  REALTIME_INTERPRETATION_DAILY_CALL_CAP,
  REALTIME_INTERPRETATION_OPERATION,
} from "../search/realtime-interpretation.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import type { CostSummary } from "./cost-truth.ts";

/** Gün penceresi; yalnızca bu değerler (adres parametresi süzülür). */
export const ANALYTICS_WINDOWS = [1, 7, 30] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export function isAnalyticsWindow(value: unknown): value is AnalyticsWindow {
  return typeof value === "number" && (ANALYTICS_WINDOWS as readonly number[]).includes(value);
}

export function parseAnalyticsWindow(raw: unknown, fallback: AnalyticsWindow = 7): AnalyticsWindow {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return isAnalyticsWindow(n) ? n : fallback;
}

export interface AiUsageRow extends CostSummary {
  operation: string;
  /** `null`: önbellek isabeti ya da modelsiz satır. */
  modelVersion: string | null;
}

export interface AiDailyRow extends CostSummary {
  day: string;
  operation: string;
}

export interface ProviderCap {
  operation: string;
  callsToday: number;
  cap: number;
}

export interface AiOperationsOverview {
  generatedAt: Date;
  days: AnalyticsWindow;
  usage: AiUsageRow[];
  daily: AiDailyRow[];
  caps: ProviderCap[];
  searchRights: {
    /** İşlem × durum (reserved/settled/refunded) sayımı, pencere içinde. */
    charges: { operation: string; state: string; count: number }[];
    refundReasons: { reason: string; count: number }[];
    /** Bugün (İstanbul) hak kullanan ve günlük limitini dolduran hesap sayısı. */
    usersToday: number;
    usersAtDailyLimitToday: number;
    dailyLimit: number;
  };
  interpretation: { status: string; count: number }[];
  chat: {
    conversationsStarted: number;
    activeConversations: number;
    userMessages: number;
    assistantByKind: { kind: string; count: number }[];
  };
}

type Num = string | number | null;
const n = (value: Num | undefined): number => Number(value ?? 0);

export async function getAiOperationsOverview(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown } = {},
  now: Date = new Date(),
): Promise<AiOperationsOverview> {
  assertCapability(actor, "ai.read");
  const days = parseAnalyticsWindow(options.days);
  const at = now.toISOString();
  const since = sql`(${at}::timestamptz - ${days}::int * interval '1 day')`;
  const todayStart = sql`((((${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date)::timestamp) AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})`;
  const today = sql`((${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date)`;
  const costColumns = sql`count(*) AS calls,
             count(*) FILTER (WHERE cache_hit) AS hits,
             COALESCE(sum(units), 0) AS units,
             COALESCE(sum(cost_micros), 0) AS cost,
             count(*) FILTER (WHERE NOT cache_hit AND cost_micros = 0) AS unpriced`;
  type CostRowRaw = { calls: Num; hits: Num; units: Num; cost: Num; unpriced: Num };
  const cost = (row: CostRowRaw): CostSummary => ({
    calls: n(row.calls),
    cacheHits: n(row.hits),
    units: n(row.units),
    costMicros: n(row.cost),
    unpricedCalls: n(row.unpriced),
  });

  return readOnly(db, 8_000, async (tx) => {
    // `api_usage_daily_idx (created_at, operation)` aralık taraması.
    const usage = await tx.execute<CostRowRaw & { operation: string; model: string | null }>(sql`
      SELECT operation, model_version AS model, ${costColumns}
        FROM api_usage
       WHERE created_at >= ${since}
       GROUP BY 1, 2
       ORDER BY count(*) DESC, 1, 2
       LIMIT 100
    `);
    const daily = await tx.execute<CostRowRaw & { day: string; operation: string }>(sql`
      SELECT to_char((created_at AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date, 'YYYY-MM-DD') AS day,
             operation, ${costColumns}
        FROM api_usage
       WHERE created_at >= ${since}
       GROUP BY 1, 2
       ORDER BY 1 DESC, 2
       LIMIT 400
    `);
    const capRows = await tx.execute<{ operation: string; calls: Num }>(sql`
      SELECT operation, count(*) AS calls
        FROM api_usage
       WHERE created_at >= ${todayStart}
         AND operation IN (${CHAT_TURN_OPERATION}, ${REALTIME_INTERPRETATION_OPERATION},
                           ${QUERY_INTERPRETATION_OPERATION})
       GROUP BY 1
    `);
    const callsToday = new Map(capRows.rows.map((row) => [row.operation, n(row.calls)]));
    const charges = await tx.execute<{ operation: string; state: string; count: Num }>(sql`
      SELECT operation, state, count(*) AS count
        FROM ai_search_charge
       WHERE created_at >= ${since}
       GROUP BY 1, 2
       ORDER BY 1, 2
    `);
    const refunds = await tx.execute<{ reason: string; count: Num }>(sql`
      SELECT refund_reason AS reason, count(*) AS count
        FROM ai_search_charge
       WHERE created_at >= ${since} AND state = 'refunded'
       GROUP BY 1
       ORDER BY 2 DESC
       LIMIT 20
    `);
    const quota = await tx.execute<{ users: Num; at_limit: Num }>(sql`
      SELECT count(*) FILTER (WHERE used > 0) AS users,
             count(*) FILTER (WHERE used >= daily_limit AND daily_limit > 0) AS at_limit
        FROM ai_quota_day
       WHERE day = ${today}
    `);
    const interpretation = await tx.execute<{ status: string; count: Num }>(sql`
      SELECT status, count(*) AS count
        FROM query_interpretation
       WHERE created_at >= ${since}
       GROUP BY 1
       ORDER BY 2 DESC
    `);
    // Sohbet: yalnızca sayılar. İçerik, başlık ve kullanıcı kimliği seçilmez.
    const chat = await tx.execute<{ started: Num; active: Num; user_messages: Num }>(sql`
      SELECT (SELECT count(*) FROM conversation WHERE created_at >= ${since}) AS started,
             (SELECT count(*) FROM conversation WHERE last_message_at >= ${since}) AS active,
             (SELECT count(*) FROM chat_message WHERE role = 'user' AND created_at >= ${since}) AS user_messages
    `);
    const assistant = await tx.execute<{ kind: string; count: Num }>(sql`
      SELECT kind, count(*) AS count
        FROM chat_message
       WHERE role = 'assistant' AND created_at >= ${since}
       GROUP BY 1
       ORDER BY 2 DESC
    `);

    const chatRow = chat.rows[0];
    const quotaRow = quota.rows[0];
    return {
      generatedAt: now,
      days,
      usage: usage.rows.map((row) => ({
        operation: row.operation,
        modelVersion: row.model,
        ...cost(row),
      })),
      daily: daily.rows.map((row) => ({ day: row.day, operation: row.operation, ...cost(row) })),
      caps: [
        { operation: CHAT_TURN_OPERATION, cap: CHAT_DAILY_CALL_CAP },
        {
          operation: REALTIME_INTERPRETATION_OPERATION,
          cap: REALTIME_INTERPRETATION_DAILY_CALL_CAP,
        },
        { operation: QUERY_INTERPRETATION_OPERATION, cap: QUERY_INTERPRETATION_DAILY_CALL_CAP },
      ].map((cap) => ({ ...cap, callsToday: callsToday.get(cap.operation) ?? 0 })),
      searchRights: {
        charges: charges.rows.map((row) => ({
          operation: row.operation,
          state: row.state,
          count: n(row.count),
        })),
        refundReasons: refunds.rows.map((row) => ({ reason: row.reason, count: n(row.count) })),
        usersToday: n(quotaRow?.users),
        usersAtDailyLimitToday: n(quotaRow?.at_limit),
        dailyLimit: QUOTA_POLICY.search_rights.day,
      },
      interpretation: interpretation.rows.map((row) => ({
        status: row.status,
        count: n(row.count),
      })),
      chat: {
        conversationsStarted: n(chatRow?.started),
        activeConversations: n(chatRow?.active),
        userMessages: n(chatRow?.user_messages),
        assistantByKind: assistant.rows.map((row) => ({ kind: row.kind, count: n(row.count) })),
      },
    };
  });
}
