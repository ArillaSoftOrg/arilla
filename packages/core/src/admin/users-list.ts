/**
 * Özet kullanıcı listesi (karar 0049 §1b). Yalnızca yönetici (`users.read`).
 *
 * - Kolonlar sabittir: kısa hesap kimliği, MASKELİ e-posta, kayıt yöntemi,
 *   rol, erken erişim, kayıt tarihi, son aktif, giriş sayısı, analitik
 *   rızası ve (rızayla tutulan) analitik sayaçları. Tam e-posta, telefon,
 *   IP, user agent, ülke, arama metni ve tıklama verisi YOKTUR.
 * - Filtreler yalnızca enum ve tarih aralığıdır; değerler allowlist ile
 *   doğrulanır, geçersiz değer sessizce yok sayılır. Serbest metin filtresi
 *   yoktur (kişi bulmak için `searchUsers`).
 * - Keyset sayfalama, sayfa başı 50 (en çok 100). Offset ve toplam sayım
 *   YOK; olay tablolarında COUNT YOK. Yalnızca `app_user`,
 *   `user_activity_summary`, `early_access` okunur; kayıt yöntemi ve
 *   analitik rızası satır başına `LATERAL ... LIMIT 1` ile (sayfa boyutuyla
 *   sınırlı, N+1 sorgu yok).
 * - Sorgu `readOnly` içinde (5 sn). Ardından ayrı bir ifadeyle `users.list`
 *   denetim kaydı yazılır: filtrelerin yalnızca ADLARI, sıralama ve yön.
 *
 * NULL sayaç "bilinmiyor"dur, asla 0 gösterilmez. Özet satırı olmayan eski
 * hesapta son giriş `app_user.last_seen_at`'ten türetilir (`derived`).
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { maskEmail, recordAdminEvent } from "./audit.ts";
import { ADMIN_PAGE_SIZE_MAX, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetDirection,
  keysetAtSql,
} from "./users-cursor.ts";

export const USER_LIST_PAGE_SIZE = 50;
const USER_LIST_TIMEOUT_MS = 5_000;

export const USER_LIST_SORTS = ["created", "last_active"] as const;
export type UserListSort = (typeof USER_LIST_SORTS)[number];

/** Kayıt yöntemi: en eski `user_identity` sağlayıcısı; kimlik yoksa ve e-posta varsa `email`. */
export const USER_LIST_PROVIDERS = ["google", "apple", "phone", "email"] as const;
export type UserListProvider = (typeof USER_LIST_PROVIDERS)[number];

export const USER_LIST_ROLES = ["user", "creator", "moderator", "admin"] as const;
export type UserListRole = (typeof USER_LIST_ROLES)[number];

export const USER_LIST_EARLY_ACCESS = ["yes", "no"] as const;

/**
 * Analitik rızası (en son `cookie_analytics` satırı):
 * - `accepted`: son satır `true` (açık)
 * - `declined`: son satır `false` — ret ya da geri alma (kapalı)
 * - `none`: hiç satır yok (kayıt yok; işleme açısından izin yok)
 */
export const USER_LIST_ANALYTICS = ["accepted", "declined", "none"] as const;
export type UserListAnalytics = (typeof USER_LIST_ANALYTICS)[number];

export interface UserListFilters {
  provider?: UserListProvider;
  role?: UserListRole;
  earlyAccess?: "yes" | "no";
  analytics?: UserListAnalytics;
  /** `YYYY-MM-DD`, Türkiye günü, dahil. */
  createdFrom?: string;
  createdTo?: string;
  lastActiveFrom?: string;
  lastActiveTo?: string;
}

export type UserListFilterName = keyof UserListFilters;

const FILTER_NAMES: readonly UserListFilterName[] = [
  "provider",
  "role",
  "earlyAccess",
  "analytics",
  "createdFrom",
  "createdTo",
  "lastActiveFrom",
  "lastActiveTo",
];

export class UserListInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserListInputError";
  }
}

function pick<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** `YYYY-MM-DD`, takvimde var olan bir gün, 2000–2100 arası; değilse `undefined`. */
export function parseListDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return undefined;
  return value;
}

/** Allowlist doğrulaması. Bilinmeyen anahtar ve geçersiz değer düşer; hata fırlatmaz. */
export function parseUserListFilters(raw: Partial<Record<string, unknown>>): UserListFilters {
  const filters: UserListFilters = {};
  const provider = pick(USER_LIST_PROVIDERS, raw.provider);
  if (provider) filters.provider = provider;
  const role = pick(USER_LIST_ROLES, raw.role);
  if (role) filters.role = role;
  const earlyAccess = pick(USER_LIST_EARLY_ACCESS, raw.earlyAccess);
  if (earlyAccess) filters.earlyAccess = earlyAccess;
  const analytics = pick(USER_LIST_ANALYTICS, raw.analytics);
  if (analytics) filters.analytics = analytics;
  for (const key of ["createdFrom", "createdTo", "lastActiveFrom", "lastActiveTo"] as const) {
    const date = parseListDate(raw[key]);
    if (date) filters[key] = date;
  }
  return filters;
}

export function parseUserListSort(raw: unknown): UserListSort {
  return pick(USER_LIST_SORTS, raw) ?? "created";
}

/** Kullanılan filtrelerin adları (denetim kaydı için; değerler değil). */
export function usedFilterNames(filters: UserListFilters): UserListFilterName[] {
  return FILTER_NAMES.filter((name) => filters[name] !== undefined);
}

const SORT_PREFIX: Record<UserListSort, string> = { created: "c", last_active: "l" };

/**
 * Liste imleci: sıralamaya bağlıdır (`c.` / `l.` öneki). Başka bir
 * sıralamanın imleci ya da bozuk imleç `null` döner → ilk sayfa.
 */
export function decodeUserListCursor(raw: unknown, sort: UserListSort) {
  if (typeof raw !== "string") return null;
  const prefix = `${SORT_PREFIX[sort]}.`;
  if (!raw.startsWith(prefix)) return null;
  return decodeKeysetCursor(raw.slice(prefix.length), "int");
}

export function encodeUserListCursor(
  sort: UserListSort,
  direction: KeysetDirection,
  at: string,
  id: number,
): string {
  return `${SORT_PREFIX[sort]}.${encodeKeysetCursor({ direction, at, id: String(id) })}`;
}

export type UserListAnalyticsState = UserListAnalytics;

export interface UserListRow {
  publicId: string;
  emailMasked: string | null;
  signupProvider: UserListProvider | null;
  role: string;
  earlyAccess: { status: string; joinedAt: Date } | null;
  createdAt: Date;
  /** Özet yoksa ya da hiç aktif görülmemişse `null` (bilinmiyor). */
  lastActiveAt: Date | null;
  lastSignInAt: Date | null;
  /** `true`: özet satırı yok, değer `app_user.last_seen_at`'ten türetildi. */
  lastSignInDerived: boolean;
  /** `null` = bilinmiyor. Sayım `serviceCountersSince`'ten beri. */
  signInCount: number | null;
  serviceCountersSince: Date | null;
  analyticsConsent: UserListAnalyticsState;
  /** Analitik sayaçları (rıza varken); `null` = bilinmiyor. `analyticsCountersSince`'ten beri. */
  searchCount: number | null;
  productViewCount: number | null;
  merchantExitCount: number | null;
  analyticsCountersSince: Date | null;
}

export interface UserListParams {
  sort?: UserListSort;
  cursor?: string | null;
  pageSize?: number;
  filters?: UserListFilters;
}

export interface UserListPage {
  sort: UserListSort;
  filters: UserListFilters;
  rows: UserListRow[];
  /** Daha eski sayfa; yoksa son sayfa. */
  nextCursor: string | null;
  /** Daha yeni sayfa; ilk sayfadaysa `null`. */
  prevCursor: string | null;
}

/** Türkiye günü başı (dahil) / ertesi gün başı (hariç) → `timestamptz`. */
function dayStart(date: string): SQL {
  return sql`(${date}::date::timestamp AT TIME ZONE 'Europe/Istanbul')`;
}
function dayEnd(date: string): SQL {
  return sql`((${date}::date + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')`;
}

type RawListRow = {
  id: string | number;
  public_id: string;
  email: string | null;
  role: string;
  created_at: string | Date;
  last_seen_at: string | Date | null;
  cursor_at: string;
  ea_status: string | null;
  ea_created_at: string | Date | null;
  has_summary: boolean;
  last_active_at: string | Date | null;
  last_sign_in_at: string | Date | null;
  sign_in_count: number | null;
  service_counters_since: string | Date | null;
  search_count: number | null;
  product_view_count: number | null;
  merchant_exit_count: number | null;
  analytics_counters_since: string | Date | null;
  signup_provider: string | null;
  analytics_granted: boolean | null;
};

const toDate = (value: string | Date | null): Date | null =>
  value === null ? null : new Date(value);

function toRow(row: RawListRow): UserListRow {
  const signupProvider: UserListProvider | null =
    pick(USER_LIST_PROVIDERS, row.signup_provider) ?? (row.email ? "email" : null);
  return {
    publicId: row.public_id,
    emailMasked: maskEmail(row.email),
    signupProvider,
    role: row.role,
    earlyAccess:
      row.ea_status && row.ea_created_at
        ? { status: row.ea_status, joinedAt: new Date(row.ea_created_at) }
        : null,
    createdAt: new Date(row.created_at),
    lastActiveAt: toDate(row.last_active_at),
    lastSignInAt: row.has_summary ? toDate(row.last_sign_in_at) : toDate(row.last_seen_at),
    lastSignInDerived: !row.has_summary,
    signInCount: row.sign_in_count,
    serviceCountersSince: toDate(row.service_counters_since),
    analyticsConsent:
      row.analytics_granted === null ? "none" : row.analytics_granted ? "accepted" : "declined",
    searchCount: row.search_count,
    productViewCount: row.product_view_count,
    merchantExitCount: row.merchant_exit_count,
    analyticsCountersSince: toDate(row.analytics_counters_since),
  };
}

export async function listUsers(
  db: Database,
  actor: AdminActor,
  params: UserListParams = {},
): Promise<UserListPage> {
  assertCapability(actor, "users.read");
  // Çağırana güvenilmez: sıralama, filtre ve sayfa boyutu burada yeniden doğrulanır.
  const sort = parseUserListSort(params.sort);
  const filters = parseUserListFilters({ ...(params.filters ?? {}) });
  const requested = Math.trunc(Number(params.pageSize ?? USER_LIST_PAGE_SIZE));
  const pageSize = Number.isFinite(requested)
    ? Math.min(Math.max(1, requested), ADMIN_PAGE_SIZE_MAX)
    : USER_LIST_PAGE_SIZE;
  const cursor = decodeUserListCursor(params.cursor, sort);

  const sortAt = sort === "created" ? sql`u.created_at` : sql`s.last_active_at`;
  const sortId = sort === "created" ? sql`u.id` : sql`s.user_id`;
  const backwards = cursor?.direction === "b";

  const where: SQL[] = [];
  if (sort === "last_active") where.push(sql`s.last_active_at IS NOT NULL`);
  if (cursor) {
    const key = sql`(${cursor.at}::timestamptz, ${cursor.id}::bigint)`;
    where.push(
      backwards ? sql`(${sortAt}, ${sortId}) > ${key}` : sql`(${sortAt}, ${sortId}) < ${key}`,
    );
  }
  if (filters.provider === "email") {
    where.push(sql`p.provider IS NULL AND u.email IS NOT NULL`);
  } else if (filters.provider) {
    where.push(sql`p.provider = ${filters.provider}`);
  }
  if (filters.role) where.push(sql`u.role = ${filters.role}`);
  if (filters.earlyAccess === "yes") where.push(sql`ea.user_id IS NOT NULL`);
  if (filters.earlyAccess === "no") where.push(sql`ea.user_id IS NULL`);
  if (filters.analytics === "accepted") where.push(sql`ca.granted IS TRUE`);
  if (filters.analytics === "declined") where.push(sql`ca.granted IS FALSE`);
  if (filters.analytics === "none") where.push(sql`ca.granted IS NULL`);
  if (filters.createdFrom) where.push(sql`u.created_at >= ${dayStart(filters.createdFrom)}`);
  if (filters.createdTo) where.push(sql`u.created_at < ${dayEnd(filters.createdTo)}`);
  if (filters.lastActiveFrom) {
    where.push(sql`s.last_active_at >= ${dayStart(filters.lastActiveFrom)}`);
  }
  if (filters.lastActiveTo) where.push(sql`s.last_active_at < ${dayEnd(filters.lastActiveTo)}`);

  const from =
    sort === "created"
      ? sql`app_user u LEFT JOIN user_activity_summary s ON s.user_id = u.id`
      : sql`user_activity_summary s JOIN app_user u ON u.id = s.user_id`;
  const direction = backwards ? sql`ASC` : sql`DESC`;

  const fetched = await readOnly(db, USER_LIST_TIMEOUT_MS, async (tx) => {
    const result = await tx.execute(sql`
      SELECT u.id, u.public_id, u.email, u.role, u.created_at, u.last_seen_at,
             ${keysetAtSql(sortAt)} AS cursor_at,
             ea.status AS ea_status, ea.created_at AS ea_created_at,
             (s.user_id IS NOT NULL) AS has_summary,
             s.last_active_at, s.last_sign_in_at, s.sign_in_count, s.service_counters_since,
             s.search_count, s.product_view_count, s.merchant_exit_count,
             s.analytics_counters_since,
             p.provider AS signup_provider,
             ca.granted AS analytics_granted
        FROM ${from}
        LEFT JOIN early_access ea ON ea.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT i.provider FROM user_identity i
           WHERE i.user_id = u.id
           ORDER BY i.created_at, i.id
           LIMIT 1
        ) p ON true
        LEFT JOIN LATERAL (
          SELECT c.granted FROM user_consent c
           WHERE c.user_id = u.id AND c.kind = 'cookie_analytics'
           ORDER BY c.granted_at DESC, c.id DESC
           LIMIT 1
        ) ca ON true
       ${where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
       ORDER BY ${sortAt} ${direction}, ${sortId} ${direction}
       LIMIT ${pageSize + 1}
    `);
    return result.rows as RawListRow[];
  });

  const hasMore = fetched.length > pageSize;
  const pageRows = fetched.slice(0, pageSize);
  if (backwards) pageRows.reverse();
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  const idOf = (row: RawListRow) => Number(row.id);

  // İleri giderken: önceki sayfa imleç varsa vardır. Geri giderken: sonraki
  // sayfa her zaman vardır (oradan geldik); önceki, fazladan satır varsa.
  const hasNext = backwards ? Boolean(cursor) : hasMore;
  const hasPrev = backwards ? hasMore : Boolean(cursor);
  const nextCursor =
    hasNext && last ? encodeUserListCursor(sort, "a", last.cursor_at, idOf(last)) : null;
  const prevCursor =
    hasPrev && first ? encodeUserListCursor(sort, "b", first.cursor_at, idOf(first)) : null;

  const rows = pageRows.map(toRow);
  await recordAdminEvent(db, {
    actor,
    action: "users.list",
    targetType: "app_user",
    targetId: "-",
    after: {
      sort,
      direction: cursor ? (backwards ? "prev" : "next") : "first",
      filters: usedFilterNames(filters),
      results: rows.length,
    },
  });

  return { sort, filters, rows, nextCursor, prevCursor };
}
