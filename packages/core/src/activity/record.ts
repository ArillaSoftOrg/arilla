/**
 * Davranışsal analitiğin TEK kapısı (docs/decisions/0049 §7). Başka hiçbir
 * yerden `user_activity_event`'e yazılmaz.
 *
 * Bir olay yalnızca şunların hepsi sağlanınca yazılır:
 * 1. Kullanıcı girişlidir. Anonim ziyaretçi için kişiye bağlı analitik yok.
 * 2. O istekteki `cookie_consent` çerezi güncel sürümde `analytics = true`.
 * 3. Hesapta o çerez kararından daha yeni bir analitik reddi yok.
 *
 * Sağlanmazsa hiçbir şey yazılmaz: olay yok, sayaç artışı yok, oturum ya da
 * çerez kimliğiyle "anonim" yedek kayıt yok.
 *
 * Arama metni kişiye bağlıdır (karar 0089): kişisel veri, kimlik/sır benzeri
 * ya da özel nitelikli veri bağlamı içeren sorguda olay yine yazılır ama
 * `query_norm` NULL kalır (`isActivityQueryStorable`).
 *
 * Olay ve sayaç AYNI işlemde yazılır. Kullanıcı başına danışma kilidi, tekrar
 * bastırmanın eşzamanlı iki istekte de tek olay üretmesini sağlar.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  type ActivityChannel,
  type ActivityEventKind,
  type Database,
  userActivityEvent,
} from "@arilla/db";
import { sql } from "drizzle-orm";
import { effectiveAnalyticsConsent, getLatestConsents } from "../consent/account-consent.ts";
import type { CookieConsent } from "../consent/cookie-consent.ts";
import { sensitiveCategory } from "../search/interpretation-eligibility.ts";
import { normalizeQueryText } from "../search/normalize.ts";
import { isSearchQualityRecordable } from "../search/quality.ts";
import { incrementAnalyticsCounter } from "./summary.ts";

export const QUERY_NORM_MAX_LENGTH = 200;
/** Aynı sorgu bu süre içinde ikinci kez sayılmaz (sayfa yenileme, sekme değişimi). */
export const SEARCH_DEDUPE_MS = 10 * 60 * 1000;
/** Aynı ürün bu süre içinde ikinci kez sayılmaz. */
export const PRODUCT_VIEW_DEDUPE_MS = 30 * 60 * 1000;
/**
 * Olay biçimi sürümü (migration 0061, karar 0100). 1 = eski satırlar (`event_id`
 * yok); 2 = `event_id` zorunlu. Bu yazıcı yalnızca 2 yazar.
 */
export const ACTIVITY_SCHEMA_VERSION = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `merchant_exit` için belirleyici kimlik: aynı tıklama ikinci kez yazılsa da aynı
 * `event_id` çıkar, böylece tekrar bir olay üretmez. UUID biçiminde, `click_id`
 * dışında bilgi taşımaz (tek yönlü özet).
 */
export function merchantExitEventId(clickId: string): string {
  const h = createHash("sha256").update(`merchant_exit:${clickId.toLowerCase()}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50; // sürüm 5 biçimi
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 varyantı
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export type ActivityInput =
  | { kind: "search_submitted"; query: string; resultCount: number | null }
  | { kind: "product_viewed"; productId: number }
  | { kind: "merchant_exit"; offerId: number; clickId: string };

export type RecordActivityOutcome = "recorded" | "no_user" | "no_consent" | "duplicate" | "invalid";

export interface RecordActivityInput {
  userId: number | null | undefined;
  cookieConsent: CookieConsent | null;
  event: ActivityInput;
  channel?: ActivityChannel;
  now?: Date;
  /**
   * İstemcinin/çağıranın ürettiği UUID: aynı kullanıcı için aynı kimlik ikinci kez
   * yazılmaz ("duplicate"). Verilmezse üretilir (`merchant_exit` için tıklamadan türetilir).
   */
  eventId?: string;
}

/** Normalize edilmiş, uzunluğu sınırlı sorgu. Boşsa `null` (olay yazılmaz). */
export function normalizeActivityQuery(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const norm = normalizeQueryText(raw).slice(0, QUERY_NORM_MAX_LENGTH).trim();
  return norm.length > 0 ? norm : null;
}

/**
 * Sorgu metni kullanıcıya bağlı olarak saklanabilir mi (karar 0089): arama
 * kalitesi süzgeci (kişisel veri, kimlik/sır benzeri) VE özel nitelikli veri
 * bağlamı yok. Kimliksiz `search_query_day` bilerek daha dar süzgeç kullanır.
 */
export function isActivityQueryStorable(queryNorm: string): boolean {
  return isSearchQualityRecordable(queryNorm) && sensitiveCategory(queryNorm) === null;
}

export async function recordActivity(
  db: Database,
  input: RecordActivityInput,
): Promise<RecordActivityOutcome> {
  const userId = input.userId;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return "no_user";
  // Çerez izin vermiyorsa veritabanına hiç gidilmez.
  if (!effectiveAnalyticsConsent(input.cookieConsent, null)) return "no_consent";

  const event = input.event;
  if (input.eventId !== undefined && !UUID_RE.test(input.eventId)) return "invalid";
  const eventId = (
    input.eventId ??
    (event.kind === "merchant_exit" ? merchantExitEventId(event.clickId) : randomUUID())
  ).toLowerCase();
  const now = input.now ?? new Date();
  let queryNorm: string | null = null;
  if (event.kind === "search_submitted") {
    queryNorm = normalizeActivityQuery(event.query);
    if (queryNorm === null) return "invalid";
    // Süzgeç kesilmemiş metne uygulanır: 200 karakterde kesme bir e-postayı ya
    // da numarayı yarıda bırakıp süzgeçten kaçırmasın.
    if (!isActivityQueryStorable(normalizeQueryText(event.query))) queryNorm = null;
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('user_activity'), ${userId}::int)`);
    const latest = await getLatestConsents(tx, userId, ["cookie_analytics"]);
    if (!effectiveAnalyticsConsent(input.cookieConsent, latest.get("cookie_analytics"))) {
      return "no_consent";
    }

    if (await isDuplicate(tx, userId, event, queryNorm, now)) return "duplicate";

    const kind: ActivityEventKind = event.kind;
    const inserted = await tx
      .insert(userActivityEvent)
      .values({
        userId,
        eventId,
        schemaVersion: ACTIVITY_SCHEMA_VERSION,
        kind,
        channel: input.channel ?? "web",
        productId: event.kind === "product_viewed" ? event.productId : null,
        offerId: event.kind === "merchant_exit" ? event.offerId : null,
        clickId: event.kind === "merchant_exit" ? event.clickId : null,
        searchMode: event.kind === "search_submitted" ? "text" : null,
        queryNorm,
        resultCount:
          event.kind === "search_submitted" && typeof event.resultCount === "number"
            ? Math.max(0, Math.trunc(event.resultCount))
            : null,
        createdAt: now,
      })
      // Aynı (user_id, event_id) tekrar gelirse sessizce atlanır; sayaç artmaz.
      .onConflictDoNothing({ target: [userActivityEvent.userId, userActivityEvent.eventId] })
      .returning({ id: userActivityEvent.id });
    if (inserted.length === 0) return "duplicate";
    await incrementAnalyticsCounter(tx, { userId, kind, at: now });
    return "recorded";
  });
}

async function isDuplicate(
  tx: Pick<Database, "execute">,
  userId: number,
  event: ActivityInput,
  queryNorm: string | null,
  now: Date,
): Promise<boolean> {
  if (event.kind === "merchant_exit") return false; // her çıkış ayrı bir tıklamadır
  const windowStart =
    event.kind === "search_submitted"
      ? new Date(now.getTime() - SEARCH_DEDUPE_MS)
      : new Date(now.getTime() - PRODUCT_VIEW_DEDUPE_MS);
  // NULL-güvenli: metni saklanmayan aramalar pencere içinde birbirinin tekrarı
  // sayılır (birkaç farklı engelli arama tek olaya iner; bilinçli az sayım).
  const match =
    event.kind === "search_submitted"
      ? sql`query_norm IS NOT DISTINCT FROM ${queryNorm}::text`
      : sql`product_id = ${event.productId}`;
  const result = await tx.execute(sql`
    SELECT 1 FROM user_activity_event
     WHERE user_id = ${userId} AND kind = ${event.kind}
       AND created_at >= ${windowStart} AND ${match}
     LIMIT 1
  `);
  return result.rows.length > 0;
}
