/**
 * Kullanıcı ayrıntısı sekmeleri (karar 0049 §2, §3, §4, §5, §6, §9). SALT
 * OKUNUR; tek yazım denetim kaydıdır.
 *
 * Her sekme fonksiyonu:
 * 1. önce yeteneği denetler (`assertCapability`),
 * 2. hesap kimliğini (UUID) doğrular; bilinmeyen hesapta `null` döner,
 * 3. okumayı `readOnly` (salt okunur işlem + zaman aşımı) içinde yapar,
 *    her liste sınırlı (`LIMIT`) ve keyset sayfalıdır,
 * 4. ardından ayrı bir işlemde denetim kaydını yazar: sayfa başına bir
 *    `users.view`, hassas sekmede (Aktivite, Oturumlar, Aramalar,
 *    Affiliate) ek olarak `users.view_tab` (yalnızca sekme adı).
 *
 * Böylece sayfa her görüntülemede tam olarak BİR sekme fonksiyonu çağırır ve
 * `users.view` bir kez yazılır.
 *
 * Hiçbir sekmede oturum token'ı, `session.ip`, ham `user_agent`, sağlayıcı
 * `subject`'i ya da `user_consent.ip` seçilmez. Tam e-posta/telefon yalnızca
 * `revealUserContact` ile (ayrı yetenek + taze giriş) döner.
 *
 * Veri sınıfları karışmaz (0049 §4–§5):
 * - Aramalar sekmesinde `ai_search_charge` (hizmet/hak kaydı) ve rızalı
 *   `search_submitted` olayları AYRI listelerdir.
 * - Affiliate sekmesi `click`/`conversion`'ı attribution kaydı olarak
 *   gösterir; buradan ilgi, segment ya da sayaç türetilmez.
 */
import type {
  ActivityChannel,
  ActivityEventKind,
  AuthEventKind,
  AuthEventProvider,
  BrowserFamily,
  Database,
  DeviceClass,
  UserConsentKind,
  UserConsentSource,
} from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { CONSENT_KINDS } from "../account/consent.ts";
import {
  COOKIE_CONSENT_KIND,
  type ConsentKindState,
  deriveConsentState,
  PRIVACY_NOTICE_VERSION,
} from "../consent/account-consent.ts";
import { type AdminEventPage, listAdminEvents, maskEmail, recordAdminEvent } from "./audit.ts";
import { ADMIN_PAGE_SIZE_MAX, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { getUserDetail, type UserDetail } from "./users.ts";
import { decodeKeysetCursor, encodeKeysetCursor, keysetAtSql } from "./users-cursor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_TIMEOUT_MS = 5_000;
export const USER_TAB_PAGE_SIZE = 50;
/** Hak kayıtları (`ai_search_charge`) sayfalanmaz: en yeni bu kadar satır. */
export const USER_CHARGE_LIMIT = 50;
/** Tıklama sayısı en fazla buraya kadar sayılır (indeks yokken tarama sınırı). */
export const USER_CLICK_COUNT_CAP = 10_000;
const ACTIVE_SESSION_LIMIT = 50;

export type UserDetailTab =
  | "profile"
  | "consents"
  | "activity"
  | "sessions"
  | "searches"
  | "affiliate"
  | "audit";

/** `users.view_tab` yazan hassas sekmeler (0049 §3). */
export const SENSITIVE_USER_TABS: readonly UserDetailTab[] = [
  "activity",
  "sessions",
  "searches",
  "affiliate",
];

export function isUserPublicId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Pick<Tx, "execute">;

/** Sekmelerin ortak başlığı. İletişim bilgisi maskeli. */
export interface UserHeader {
  id: number;
  publicId: string;
  displayName: string | null;
  emailMasked: string | null;
  role: string;
}

async function findUser(tx: Executor, publicId: string): Promise<UserHeader | null> {
  const result = await tx.execute(sql`
    SELECT id, public_id, display_name, email, role
      FROM app_user WHERE public_id = ${publicId.toLowerCase()}::uuid
  `);
  const row = result.rows[0] as
    | {
        id: string | number;
        public_id: string;
        display_name: string | null;
        email: string | null;
        role: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    publicId: row.public_id,
    displayName: row.display_name,
    emailMasked: maskEmail(row.email),
    role: row.role,
  };
}

/** Sayfa başına bir `users.view`; hassas sekmede ek `users.view_tab`. Değer yazılmaz. */
async function auditView(
  db: Database,
  actor: AdminActor,
  userId: number,
  tab: UserDetailTab,
): Promise<void> {
  await db.transaction(async (tx) => {
    await recordAdminEvent(tx, {
      actor,
      action: "users.view",
      targetType: "app_user",
      targetId: userId,
      after: { tab },
    });
    if (SENSITIVE_USER_TABS.includes(tab)) {
      await recordAdminEvent(tx, {
        actor,
        action: "users.view_tab",
        targetType: "app_user",
        targetId: userId,
        after: { tab },
      });
    }
  });
}

export interface TabPageOptions {
  /** Önceki sayfanın `nextCursor`'u. Geçersizse ilk sayfa. */
  cursor?: string | null;
  pageSize?: number;
}

function tabPageSize(value: number | undefined): number {
  const n = Math.trunc(Number(value ?? USER_TAB_PAGE_SIZE));
  return Number.isFinite(n) ? Math.min(Math.max(1, n), ADMIN_PAGE_SIZE_MAX) : USER_TAB_PAGE_SIZE;
}

/** Yalnızca "daha eski" yönü: `(at, id) < imleç`. */
function olderThan(
  raw: string | null | undefined,
  idKind: "int" | "uuid",
  atColumn: SQL,
  idColumn: SQL,
): SQL {
  const cursor = decodeKeysetCursor(raw, idKind);
  if (cursor?.direction !== "a") return sql`true`;
  const id = idKind === "int" ? sql`${cursor.id}::bigint` : sql`${cursor.id}::uuid`;
  return sql`(${atColumn}, ${idColumn}) < (${cursor.at}::timestamptz, ${id})`;
}

function nextCursorOf<T extends { cursor_at: string; id: string | number }>(
  fetched: T[],
  pageSize: number,
): string | null {
  if (fetched.length <= pageSize) return null;
  const last = fetched[pageSize - 1];
  return last
    ? encodeKeysetCursor({ direction: "a", at: last.cursor_at, id: String(last.id) })
    : null;
}

const toDate = (value: string | Date | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

// ---------------------------------------------------------------------------
// Profil (users.read)
// ---------------------------------------------------------------------------

export interface UserServiceSummary {
  /** `false`: özet satırı yok (eski hesap); alanlar `app_user`'dan türetildi. */
  hasSummary: boolean;
  /** Her durumda `app_user.created_at` (hesap yalnızca başarılı girişte açılır). */
  firstSignInAt: Date;
  lastSignInAt: Date | null;
  /** `true`: `app_user.last_seen_at`'ten türetildi. */
  lastSignInDerived: boolean;
  lastActiveAt: Date | null;
  /** `null` = bilinmiyor. `serviceCountersSince`'ten beri. */
  signInCount: number | null;
  serviceCountersSince: Date | null;
}

export interface UserProfile extends UserDetail {
  service: UserServiceSummary;
}

/**
 * Profil sekmesi: `getUserDetail` (kimlik, giriş yöntemleri, hak, davet,
 * erken erişim; `users.view` yazar) + hizmet özeti. Sağlayıcı `subject`'i,
 * tam iletişim bilgisi yok.
 */
export async function getUserProfile(
  db: Database,
  actor: AdminActor,
  publicId: string,
): Promise<UserProfile | null> {
  assertCapability(actor, "users.read");
  if (!isUserPublicId(publicId)) return null;
  const detail = await getUserDetail(db, actor, publicId);
  if (!detail) return null;

  const service = await readOnly(db, TAB_TIMEOUT_MS, async (tx) => {
    const result = await tx.execute(sql`
      SELECT s.first_sign_in_at, s.last_sign_in_at, s.last_active_at,
             s.sign_in_count, s.service_counters_since
        FROM user_activity_summary s WHERE s.user_id = ${detail.id}
    `);
    return result.rows[0] as
      | {
          first_sign_in_at: string | Date | null;
          last_sign_in_at: string | Date | null;
          last_active_at: string | Date | null;
          sign_in_count: number | null;
          service_counters_since: string | Date | null;
        }
      | undefined;
  });

  return {
    ...detail,
    service: service
      ? {
          hasSummary: true,
          firstSignInAt: toDate(service.first_sign_in_at) ?? detail.createdAt,
          lastSignInAt: toDate(service.last_sign_in_at),
          lastSignInDerived: false,
          lastActiveAt: toDate(service.last_active_at),
          signInCount: service.sign_in_count,
          serviceCountersSince: toDate(service.service_counters_since),
        }
      : {
          hasSummary: false,
          firstSignInAt: detail.createdAt,
          lastSignInAt: detail.lastSeenAt,
          lastSignInDerived: true,
          lastActiveAt: null,
          signInCount: null,
          serviceCountersSince: null,
        },
  };
}

// ---------------------------------------------------------------------------
// İzinler (users.read)
// ---------------------------------------------------------------------------

export const ACCOUNT_CONSENT_KINDS: readonly UserConsentKind[] = CONSENT_KINDS;
export const COOKIE_CONSENT_KINDS: readonly UserConsentKind[] = Object.values(COOKIE_CONSENT_KIND);

export interface ConsentHistoryEntry {
  /** Liste anahtarı (satır kimliği; gösterilmez). */
  key: string;
  kind: UserConsentKind;
  granted: boolean;
  grantedAt: Date;
  source: UserConsentSource | null;
  textVersion: string | null;
  /** `text_version` yok (0037 öncesi). Yalnızca bilgi; durumu değiştirmez. */
  versionless: boolean;
}

export interface PrivacyNoticeView {
  textVersion: string | null;
  shownAt: Date;
  source: UserConsentSource | null;
  /** Gösterilen sürüm güncel aydınlatma metni mi. */
  isCurrent: boolean;
}

export interface UserConsentsView {
  user: UserHeader;
  /** `/hesap` izinleri: gezinme geçmişi, pazarlama, kişiselleştirme, keşfet. */
  account: ConsentKindState[];
  /** Çerez kategorileri (işlevsel, analitik, pazarlama). */
  cookies: ConsentKindState[];
  /** Rıza DEĞİLDİR: hangi aydınlatma metni sürümü gösterildi. Hiç yoksa `null`. */
  privacyNotice: PrivacyNoticeView | null;
  currentPrivacyNoticeVersion: string;
  /** Tüm türler, yeniden eskiye (`granted_at DESC, id DESC`). IP YOK. */
  history: ConsentHistoryEntry[];
  nextCursor: string | null;
}

export async function getUserConsents(
  db: Database,
  actor: AdminActor,
  publicId: string,
  options: TabPageOptions = {},
): Promise<UserConsentsView | null> {
  assertCapability(actor, "users.read");
  if (!isUserPublicId(publicId)) return null;
  const pageSize = tabPageSize(options.pageSize);

  const data = await readOnly(db, TAB_TIMEOUT_MS, async (tx) => {
    const user = await findUser(tx, publicId);
    if (!user) return null;
    // Tür başına en son satır + geçmişte hiç `true` var mı (ret/geri alma
    // ayrımı). Pencere fonksiyonu DISTINCT ON'dan önce hesaplanır.
    const latest = await tx.execute(sql`
      SELECT DISTINCT ON (kind)
             id, kind, granted, granted_at, source, text_version,
             bool_or(granted) OVER (PARTITION BY kind) AS ever_granted
        FROM user_consent
       WHERE user_id = ${user.id}
       ORDER BY kind, granted_at DESC, id DESC
    `);
    const history = await tx.execute(sql`
      SELECT id, kind, granted, granted_at, source, text_version,
             ${keysetAtSql(sql`granted_at`)} AS cursor_at
        FROM user_consent
       WHERE user_id = ${user.id}
         AND ${olderThan(options.cursor, "int", sql`granted_at`, sql`id`)}
       ORDER BY granted_at DESC, id DESC
       LIMIT ${pageSize + 1}
    `);
    return {
      user,
      latest: latest.rows as {
        id: string | number;
        kind: UserConsentKind;
        granted: boolean;
        granted_at: string | Date;
        source: UserConsentSource | null;
        text_version: string | null;
        ever_granted: boolean;
      }[],
      history: history.rows as {
        id: string | number;
        kind: UserConsentKind;
        granted: boolean;
        granted_at: string | Date;
        source: UserConsentSource | null;
        text_version: string | null;
        cursor_at: string;
      }[],
    };
  });
  if (!data) return null;
  await auditView(db, actor, data.user.id, "consents");

  const latestByKind = new Map(data.latest.map((row) => [row.kind, row]));
  /**
   * `deriveConsentState` tüm geçmişi ister; burada son satır ve "öncesinde
   * kabul var mı" bilgisi yeterlidir. Son satır `false` ve öncesinde `true`
   * varsa, sıralamada son satırın ARKASINA düşen temsilî bir `true` satırı
   * eklenir (yalnızca durum türetmek için; gösterilmez).
   */
  const stateOf = (kind: UserConsentKind): ConsentKindState => {
    const row = latestByKind.get(kind);
    if (!row) return deriveConsentState(kind, []);
    const latestRow = {
      id: Number(row.id),
      kind,
      granted: row.granted,
      grantedAt: new Date(row.granted_at),
      source: row.source,
      textVersion: row.text_version,
    };
    const earlier =
      !row.granted && row.ever_granted
        ? [
            {
              ...latestRow,
              id: 0,
              granted: true,
              grantedAt: new Date(latestRow.grantedAt.getTime() - 1),
            },
          ]
        : [];
    return deriveConsentState(kind, [latestRow, ...earlier]);
  };

  const notice = latestByKind.get("privacy_notice");
  const pageRows = data.history.slice(0, pageSize);
  return {
    user: data.user,
    account: ACCOUNT_CONSENT_KINDS.map(stateOf),
    cookies: COOKIE_CONSENT_KINDS.map(stateOf),
    privacyNotice: notice
      ? {
          textVersion: notice.text_version,
          shownAt: new Date(notice.granted_at),
          source: notice.source,
          isCurrent: notice.text_version === PRIVACY_NOTICE_VERSION,
        }
      : null,
    currentPrivacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    history: pageRows.map((row) => ({
      key: String(row.id),
      kind: row.kind,
      granted: row.granted,
      grantedAt: new Date(row.granted_at),
      source: row.source,
      textVersion: row.text_version,
      versionless: row.text_version === null,
    })),
    nextCursor: nextCursorOf(data.history, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Aktivite (users.activity.read) — rızalı davranışsal analitik
// ---------------------------------------------------------------------------

export interface AnalyticsCounters {
  /** Özet yok ya da rıza yok/geri alındı → hepsi `null` (bilinmiyor). */
  searchCount: number | null;
  productViewCount: number | null;
  merchantExitCount: number | null;
  lastSearchAt: Date | null;
  analyticsCountersSince: Date | null;
}

export interface ActivityEventRow {
  /** Liste anahtarı (satır kimliği; gösterilmez). */
  key: string;
  kind: ActivityEventKind;
  channel: ActivityChannel;
  createdAt: Date;
  /** Yalnızca `product_viewed`. */
  product: { title: string; slug: string } | null;
  /** Yalnızca `merchant_exit`. Tıklama kimliği gösterilmez. */
  merchantName: string | null;
  /** Yalnızca `search_submitted`; 90 günde NULL'a çekilir. */
  queryNorm: string | null;
  resultCount: number | null;
}

export interface UserActivityView {
  user: UserHeader;
  counters: AnalyticsCounters;
  events: ActivityEventRow[];
  nextCursor: string | null;
}

async function readAnalyticsCounters(tx: Executor, userId: number): Promise<AnalyticsCounters> {
  const result = await tx.execute(sql`
    SELECT search_count, product_view_count, merchant_exit_count, last_search_at,
           analytics_counters_since
      FROM user_activity_summary WHERE user_id = ${userId}
  `);
  const row = result.rows[0] as
    | {
        search_count: number | null;
        product_view_count: number | null;
        merchant_exit_count: number | null;
        last_search_at: string | Date | null;
        analytics_counters_since: string | Date | null;
      }
    | undefined;
  return {
    searchCount: row?.search_count ?? null,
    productViewCount: row?.product_view_count ?? null,
    merchantExitCount: row?.merchant_exit_count ?? null,
    lastSearchAt: toDate(row?.last_search_at),
    analyticsCountersSince: toDate(row?.analytics_counters_since),
  };
}

type RawActivityRow = {
  id: string | number;
  cursor_at: string;
  kind: ActivityEventKind;
  channel: ActivityChannel;
  created_at: string | Date;
  query_norm: string | null;
  result_count: number | null;
  product_title: string | null;
  product_slug: string | null;
  merchant_name: string | null;
};

function toActivityRow(row: RawActivityRow): ActivityEventRow {
  const isSearch = row.kind === "search_submitted";
  return {
    key: String(row.id),
    kind: row.kind,
    channel: row.channel,
    createdAt: new Date(row.created_at),
    product:
      row.kind === "product_viewed" && row.product_title && row.product_slug
        ? { title: row.product_title, slug: row.product_slug }
        : null,
    merchantName: row.kind === "merchant_exit" ? row.merchant_name : null,
    queryNorm: isSearch ? row.query_norm : null,
    resultCount: isSearch ? row.result_count : null,
  };
}

export async function getUserActivity(
  db: Database,
  actor: AdminActor,
  publicId: string,
  options: TabPageOptions = {},
): Promise<UserActivityView | null> {
  assertCapability(actor, "users.activity.read");
  if (!isUserPublicId(publicId)) return null;
  const pageSize = tabPageSize(options.pageSize);

  const data = await readOnly(db, TAB_TIMEOUT_MS, async (tx) => {
    const user = await findUser(tx, publicId);
    if (!user) return null;
    const counters = await readAnalyticsCounters(tx, user.id);
    const events = await tx.execute(sql`
      SELECT e.id, ${keysetAtSql(sql`e.created_at`)} AS cursor_at,
             e.kind, e.channel, e.created_at, e.query_norm, e.result_count,
             p.title AS product_title, p.slug AS product_slug,
             m.name AS merchant_name
        FROM user_activity_event e
        LEFT JOIN product p ON p.id = e.product_id
        LEFT JOIN offer o ON o.id = e.offer_id
        LEFT JOIN merchant m ON m.id = o.merchant_id
       WHERE e.user_id = ${user.id}
         AND ${olderThan(options.cursor, "int", sql`e.created_at`, sql`e.id`)}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${pageSize + 1}
    `);
    return { user, counters, events: events.rows as RawActivityRow[] };
  });
  if (!data) return null;
  await auditView(db, actor, data.user.id, "activity");

  return {
    user: data.user,
    counters: data.counters,
    events: data.events.slice(0, pageSize).map(toActivityRow),
    nextCursor: nextCursorOf(data.events, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Oturumlar (users.activity.read) — hizmet/güvenlik
// ---------------------------------------------------------------------------

export interface ActiveSessionRow {
  deviceClass: DeviceClass | null;
  browserFamily: BrowserFamily | null;
  countryCode: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export interface AuthEventRow {
  /** Liste anahtarı (satır kimliği; gösterilmez). */
  key: string;
  kind: AuthEventKind;
  provider: AuthEventProvider | null;
  deviceClass: DeviceClass | null;
  browserFamily: BrowserFamily | null;
  countryCode: string | null;
  createdAt: Date;
}

export interface UserSessionsView {
  user: UserHeader;
  /** Son görülen kaba bağlam (özet); özet yoksa hepsi `null`. */
  lastContext: {
    deviceClass: DeviceClass | null;
    browserFamily: BrowserFamily | null;
    countryCode: string | null;
  };
  /** `expires_at > now()`, en son kullanılan önce; en fazla 50. IP/user agent YOK. */
  activeSessions: ActiveSessionRow[];
  authEvents: AuthEventRow[];
  nextCursor: string | null;
}

export async function getUserSessions(
  db: Database,
  actor: AdminActor,
  publicId: string,
  options: TabPageOptions = {},
): Promise<UserSessionsView | null> {
  assertCapability(actor, "users.activity.read");
  if (!isUserPublicId(publicId)) return null;
  const pageSize = tabPageSize(options.pageSize);

  const data = await readOnly(db, TAB_TIMEOUT_MS, async (tx) => {
    const user = await findUser(tx, publicId);
    if (!user) return null;
    // Bilerek açık kolon listesi: `ip`, `user_agent`, `token_hash`, `id` seçilmez.
    const sessions = await tx.execute(sql`
      SELECT device_class, browser_family, country_code, created_at, last_used_at, expires_at
        FROM session
       WHERE user_id = ${user.id} AND expires_at > now()
       ORDER BY last_used_at DESC
       LIMIT ${ACTIVE_SESSION_LIMIT}
    `);
    const summary = await tx.execute(sql`
      SELECT last_device_class, last_browser_family, last_country_code
        FROM user_activity_summary WHERE user_id = ${user.id}
    `);
    const events = await tx.execute(sql`
      SELECT id, ${keysetAtSql(sql`created_at`)} AS cursor_at,
             kind, provider, device_class, browser_family, country_code, created_at
        FROM auth_event
       WHERE user_id = ${user.id}
         AND ${olderThan(options.cursor, "int", sql`created_at`, sql`id`)}
       ORDER BY created_at DESC, id DESC
       LIMIT ${pageSize + 1}
    `);
    return {
      user,
      sessions: sessions.rows as {
        device_class: DeviceClass | null;
        browser_family: BrowserFamily | null;
        country_code: string | null;
        created_at: string | Date;
        last_used_at: string | Date;
        expires_at: string | Date;
      }[],
      summary: summary.rows[0] as
        | {
            last_device_class: DeviceClass | null;
            last_browser_family: BrowserFamily | null;
            last_country_code: string | null;
          }
        | undefined,
      events: events.rows as {
        id: string | number;
        cursor_at: string;
        kind: AuthEventKind;
        provider: AuthEventProvider | null;
        device_class: DeviceClass | null;
        browser_family: BrowserFamily | null;
        country_code: string | null;
        created_at: string | Date;
      }[],
    };
  });
  if (!data) return null;
  await auditView(db, actor, data.user.id, "sessions");

  return {
    user: data.user,
    lastContext: {
      deviceClass: data.summary?.last_device_class ?? null,
      browserFamily: data.summary?.last_browser_family ?? null,
      countryCode: data.summary?.last_country_code ?? null,
    },
    activeSessions: data.sessions.map((row) => ({
      deviceClass: row.device_class,
      browserFamily: row.browser_family,
      countryCode: row.country_code,
      createdAt: new Date(row.created_at),
      lastUsedAt: new Date(row.last_used_at),
      expiresAt: new Date(row.expires_at),
    })),
    authEvents: data.events.slice(0, pageSize).map((row) => ({
      key: String(row.id),
      kind: row.kind,
      provider: row.provider,
      deviceClass: row.device_class,
      browserFamily: row.browser_family,
      countryCode: row.country_code,
      createdAt: new Date(row.created_at),
    })),
    nextCursor: nextCursorOf(data.events, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Aramalar (users.activity.read) — iki ayrı sınıf
// ---------------------------------------------------------------------------

export interface SearchChargeRow {
  /** Liste anahtarı (satır kimliği; gösterilmez). */
  key: string;
  operation: string;
  state: string;
  cost: number;
  fromDaily: number;
  fromBonus: number;
  refundReason: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

export interface TextSearchRow {
  /** Liste anahtarı (satır kimliği; gösterilmez). */
  key: string;
  channel: ActivityChannel;
  createdAt: Date;
  /** 90 günde NULL'a çekilir. */
  queryNorm: string | null;
  resultCount: number | null;
}

export interface UserSearchesView {
  user: UserHeader;
  /** Hizmet/hak kaydı: fotoğrafla ve linkle aramalar. Rızadan bağımsız. En yeni 50. */
  charges: SearchChargeRow[];
  chargesTruncated: boolean;
  /** Rızalı analitik: metin aramaları (`search_submitted`). */
  textSearches: TextSearchRow[];
  textSearchCount: number | null;
  analyticsCountersSince: Date | null;
  nextCursor: string | null;
}

export async function getUserSearches(
  db: Database,
  actor: AdminActor,
  publicId: string,
  options: TabPageOptions = {},
): Promise<UserSearchesView | null> {
  assertCapability(actor, "users.activity.read");
  if (!isUserPublicId(publicId)) return null;
  const pageSize = tabPageSize(options.pageSize);

  const data = await readOnly(db, TAB_TIMEOUT_MS, async (tx) => {
    const user = await findUser(tx, publicId);
    if (!user) return null;
    const charges = await tx.execute(sql`
      SELECT id, operation, state, cost, from_daily, from_bonus, refund_reason, created_at, finalized_at
        FROM ai_search_charge
       WHERE user_id = ${user.id}
       ORDER BY created_at DESC, id DESC
       LIMIT ${USER_CHARGE_LIMIT + 1}
    `);
    const counters = await readAnalyticsCounters(tx, user.id);
    const searches = await tx.execute(sql`
      SELECT id, ${keysetAtSql(sql`created_at`)} AS cursor_at,
             channel, created_at, query_norm, result_count
        FROM user_activity_event
       WHERE user_id = ${user.id} AND kind = 'search_submitted'
         AND ${olderThan(options.cursor, "int", sql`created_at`, sql`id`)}
       ORDER BY created_at DESC, id DESC
       LIMIT ${pageSize + 1}
    `);
    return {
      user,
      counters,
      charges: charges.rows as {
        id: string;
        operation: string;
        state: string;
        cost: number;
        from_daily: number;
        from_bonus: number;
        refund_reason: string | null;
        created_at: string | Date;
        finalized_at: string | Date | null;
      }[],
      searches: searches.rows as {
        id: string | number;
        cursor_at: string;
        channel: ActivityChannel;
        created_at: string | Date;
        query_norm: string | null;
        result_count: number | null;
      }[],
    };
  });
  if (!data) return null;
  await auditView(db, actor, data.user.id, "searches");

  return {
    user: data.user,
    charges: data.charges.slice(0, USER_CHARGE_LIMIT).map((row) => ({
      key: row.id,
      operation: row.operation,
      state: row.state,
      cost: row.cost,
      fromDaily: row.from_daily,
      fromBonus: row.from_bonus,
      refundReason: row.refund_reason,
      createdAt: new Date(row.created_at),
      finalizedAt: toDate(row.finalized_at),
    })),
    chargesTruncated: data.charges.length > USER_CHARGE_LIMIT,
    textSearches: data.searches.slice(0, pageSize).map((row) => ({
      key: String(row.id),
      channel: row.channel,
      createdAt: new Date(row.created_at),
      queryNorm: row.query_norm,
      resultCount: row.result_count,
    })),
    textSearchCount: data.counters.searchCount,
    analyticsCountersSince: data.counters.analyticsCountersSince,
    nextCursor: nextCursorOf(data.searches, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Affiliate (users.activity.read) — attribution kaydı, profil değil
// ---------------------------------------------------------------------------

export interface AttributionClickRow {
  /** Liste anahtarı (satır kimliği; gösterilmez). */
  key: string;
  createdAt: Date;
  merchantName: string;
  surface: string | null;
  channel: string;
  /** Kuruş. */
  priceAtClick: number | null;
  /** Bu tıklamaya bağlı en son dönüşüm; yoksa `null`. */
  conversion: { status: string; occurredAt: Date } | null;
}

export interface UserAffiliateView {
  user: UserHeader;
  /** En fazla `USER_CLICK_COUNT_CAP` sayılır; `clickCountCapped` ise gerçek sayı daha büyük. */
  clickCount: number;
  clickCountCapped: boolean;
  conversionsByStatus: { status: string; count: number }[];
  clicks: AttributionClickRow[];
  nextCursor: string | null;
}

export async function getUserAffiliate(
  db: Database,
  actor: AdminActor,
  publicId: string,
  options: TabPageOptions = {},
): Promise<UserAffiliateView | null> {
  assertCapability(actor, "users.activity.read");
  if (!isUserPublicId(publicId)) return null;
  const pageSize = tabPageSize(options.pageSize);

  const data = await readOnly(db, TAB_TIMEOUT_MS, async (tx) => {
    const user = await findUser(tx, publicId);
    if (!user) return null;
    const count = await tx.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM click WHERE user_id = ${user.id} LIMIT ${USER_CLICK_COUNT_CAP + 1}
      ) t
    `);
    const conversions = await tx.execute(sql`
      SELECT cv.status, count(*)::int AS count
        FROM conversion cv
        JOIN click c ON c.id = cv.click_id
       WHERE c.user_id = ${user.id}
       GROUP BY cv.status
       ORDER BY cv.status
    `);
    const clicks = await tx.execute(sql`
      SELECT c.id, ${keysetAtSql(sql`c.created_at`)} AS cursor_at,
             c.created_at, m.name AS merchant_name, c.surface, c.channel, c.price_at_click,
             cv.status AS conversion_status, cv.occurred_at AS conversion_at
        FROM click c
        JOIN offer o ON o.id = c.offer_id
        JOIN merchant m ON m.id = o.merchant_id
        LEFT JOIN LATERAL (
          SELECT status, occurred_at FROM conversion
           WHERE click_id = c.id
           ORDER BY occurred_at DESC, id DESC
           LIMIT 1
        ) cv ON true
       WHERE c.user_id = ${user.id}
         AND ${olderThan(options.cursor, "uuid", sql`c.created_at`, sql`c.id`)}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${pageSize + 1}
    `);
    return {
      user,
      count: Number((count.rows[0] as { n: number } | undefined)?.n ?? 0),
      conversions: conversions.rows as { status: string; count: number }[],
      clicks: clicks.rows as {
        id: string;
        cursor_at: string;
        created_at: string | Date;
        merchant_name: string;
        surface: string | null;
        channel: string;
        price_at_click: string | number | null;
        conversion_status: string | null;
        conversion_at: string | Date | null;
      }[],
    };
  });
  if (!data) return null;
  await auditView(db, actor, data.user.id, "affiliate");

  return {
    user: data.user,
    clickCount: Math.min(data.count, USER_CLICK_COUNT_CAP),
    clickCountCapped: data.count > USER_CLICK_COUNT_CAP,
    conversionsByStatus: data.conversions,
    clicks: data.clicks.slice(0, pageSize).map((row) => ({
      key: row.id,
      createdAt: new Date(row.created_at),
      merchantName: row.merchant_name,
      surface: row.surface,
      channel: row.channel,
      priceAtClick: row.price_at_click === null ? null : Number(row.price_at_click),
      conversion:
        row.conversion_status && row.conversion_at
          ? { status: row.conversion_status, occurredAt: new Date(row.conversion_at) }
          : null,
    })),
    nextCursor: nextCursorOf(data.clicks, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Denetim (users.read + audit.read)
// ---------------------------------------------------------------------------

export interface UserAuditView {
  user: UserHeader;
  events: AdminEventPage;
}

/** Bu hesabı hedef alan yönetim kayıtları (`listAdminEvents`, `id` imleci). */
export async function getUserAudit(
  db: Database,
  actor: AdminActor,
  publicId: string,
  options: { beforeId?: number } = {},
): Promise<UserAuditView | null> {
  assertCapability(actor, "users.read");
  assertCapability(actor, "audit.read");
  if (!isUserPublicId(publicId)) return null;
  const user = await readOnly(db, TAB_TIMEOUT_MS, (tx) => findUser(tx, publicId));
  if (!user) return null;
  const beforeId =
    Number.isSafeInteger(options.beforeId) && (options.beforeId ?? 0) > 0
      ? options.beforeId
      : undefined;
  const events = await listAdminEvents(db, actor, {
    targetType: "app_user",
    targetId: String(user.id),
    beforeId,
  });
  await auditView(db, actor, user.id, "audit");
  return { user, events };
}

// ---------------------------------------------------------------------------
// Tam iletişim bilgisi (users.contact.reveal + taze giriş)
// ---------------------------------------------------------------------------

export type ContactField = "email" | "phone";
export const CONTACT_FIELDS: readonly ContactField[] = ["email", "phone"];

/** Taze giriş yoksa core da reddeder: arayüzün söylediğine körü körüne güvenilmez. */
export class FreshAuthRequiredError extends Error {
  constructor() {
    super("taze giris gerekli");
    this.name = "FreshAuthRequiredError";
  }
}

export interface RevealedContact {
  field: ContactField;
  /** Tam değer; hesapta yoksa `null`. Yalnızca bu yanıtta döner, hiçbir yere yazılmaz. */
  value: string | null;
}

/**
 * Tek hesabın tam e-postasını ya da telefonunu döndürür (0049 §2).
 * `users.reveal_contact` denetim kaydı AYNI işlemde yazılır; kayıtta
 * yalnızca alan adı vardır, DEĞER ASLA. Kayıt yazılamazsa değer dönmez.
 */
export async function revealUserContact(
  db: Database,
  actor: AdminActor,
  publicId: string,
  field: ContactField,
  options: { fresh: boolean },
): Promise<RevealedContact | null> {
  assertCapability(actor, "users.contact.reveal");
  if (options?.fresh !== true) throw new FreshAuthRequiredError();
  if (!CONTACT_FIELDS.includes(field)) throw new Error("gecersiz alan");
  if (!isUserPublicId(publicId)) return null;

  return db.transaction(async (tx) => {
    const user = await findUser(tx, publicId);
    if (!user) return null;
    const result =
      field === "email"
        ? await tx.execute(sql`SELECT email AS value FROM app_user WHERE id = ${user.id}`)
        : await tx.execute(sql`
            SELECT provider_subject AS value FROM user_identity
             WHERE user_id = ${user.id} AND provider = 'phone'
             ORDER BY created_at, id LIMIT 1
          `);
    const value = (result.rows[0] as { value: string | null } | undefined)?.value ?? null;
    await recordAdminEvent(tx, {
      actor,
      action: "users.reveal_contact",
      targetType: "app_user",
      targetId: user.id,
      after: { field },
    });
    return { field, value };
  });
}
