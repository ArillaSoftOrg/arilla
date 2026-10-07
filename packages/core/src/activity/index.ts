/**
 * Kullanıcı aktivitesi (docs/decisions/0049): kaba istek bağlamı, giriş/çıkış
 * geçmişi, kullanıcı özeti, rızalı analitik kapısı ve saklama süreleri.
 */
export {
  recordSessionEnd,
  recordSignIn,
  type SessionEndKind,
  type SignInEventInput,
} from "./auth-events.ts";
export {
  listRecentSearches,
  RECENT_SEARCHES_DEFAULT_LIMIT,
  RECENT_SEARCHES_MAX_LIMIT,
  type RecentSearch,
} from "./recent-searches.ts";
export {
  type ActivityInput,
  normalizeActivityQuery,
  PRODUCT_VIEW_DEDUPE_MS,
  QUERY_NORM_MAX_LENGTH,
  type RecordActivityInput,
  type RecordActivityOutcome,
  recordActivity,
  SEARCH_DEDUPE_MS,
} from "./record.ts";
export {
  COUNTRY_HEADER,
  classifyBrowser,
  classifyDevice,
  EMPTY_REQUEST_CONTEXT,
  normalizeCountryCode,
  type RequestContext,
  requestContextFromHeaders,
} from "./request-context.ts";
export {
  ACTIVITY_EVENT_RETENTION_DAYS,
  AUTH_EVENT_RETENTION_DAYS,
  CONSENT_IP_RETENTION_DAYS,
  type PurgeOptions,
  type PurgeResult,
  purgeExpiredActivity,
  QUERY_NORM_RETENTION_DAYS,
} from "./retention.ts";
export { LAST_ACTIVE_THROTTLE_MS, shouldTouchLastActive } from "./summary.ts";
