/**
 * `/yonetim/ayarlar` (karar 0086): etkin yapılandırmanın SALT OKUNUR görünümü.
 *
 * Kurallar:
 * - SIR DEĞERİ HİÇ DÖNMEZ. Anahtar, parola, token ve bağlantı adresleri
 *   (`secret: true`) yalnızca `set` / `missing` / `invalid` durumu taşır;
 *   `value` her zaman `null`dır. Bağlantı adresleri yalnızca ayrıştırılabilir
 *   mi diye denetlenir; içerikleri (kullanıcı, parola, makine) dışarı çıkmaz.
 * - Sır olmayan ayarlar ETKİN değeriyle gösterilir: kodun okuduğu fonksiyon
 *   (ör. `isChatImageEnabled`) çağrılır, ham ortam değeri değil.
 * - Durumlar: `set` (tanımlı, geçerli), `default` (tanımsız, kod varsayılanı),
 *   `missing` (tanımsız; özellik kapalı ya da çalışmaz), `invalid` (tanımlı
 *   ama geçersiz; varsayılana düşer), `unknown` (bu süreçten görülemez — ör.
 *   yalnızca Python işlerinin ortamı), `code` (ortam değil, kod sabiti).
 * - Çalışırken değiştirme YOK.
 */

import { isProductOpen } from "../access/product-access.ts";
import { GA4_ENV, ga4ApiConfigFromEnv } from "../analytics-ga4/config.ts";
import { parseMeasurementId } from "../analytics-ga4/measurement.ts";
import {
  CHAT_DAILY_CALL_CAP,
  chatTurnsPerHour,
  DEFAULT_CHAT_TURNS_PER_HOUR,
  isChatDiscoveryEnabled,
  isChatImageEnabled,
} from "../chat/config.ts";
import {
  AI_SEARCH_RATE_LIMITS,
  BONUS_BALANCE_MAX,
  DEFAULT_DAILY_SEARCH_LIMIT,
  dailySearchLimit,
} from "../entitlement/config.ts";
import { LLM_COST_FX_ENV, parseFxMicros } from "../llm/pricing.ts";
import { QUOTA_POLICY, QUOTA_WINDOWS } from "../quota/policy.ts";
import { QUERY_INTERPRETATION_DAILY_CALL_CAP } from "../search/query-interpretation.ts";
import {
  isRealtimeInterpretationEnabled,
  REALTIME_INTERPRETATION_DAILY_CALL_CAP,
} from "../search/realtime-interpretation.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type ConfigState = "set" | "default" | "missing" | "invalid" | "unknown" | "code";

export const CONFIG_GROUPS = [
  "product",
  "ai",
  "analytics",
  "email",
  "auth",
  "infrastructure",
  "runtime",
] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

export interface ConfigEntry {
  key: string;
  label: string;
  group: ConfigGroup;
  /** Sır: `value` daima `null`. */
  secret: boolean;
  state: ConfigState;
  /** Sır olmayan ayarın etkin, gösterime hazır değeri. */
  value: string | null;
  note?: string;
}

export interface QuotaRow {
  pool: string;
  windows: { window: string; limit: number }[];
}

export interface ConfigView {
  entries: ConfigEntry[];
  quotas: QuotaRow[];
  caps: { key: string; label: string; value: number }[];
}

function raw(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

const onOff = (on: boolean) => (on ? "Açık" : "Kapalı");

/** Sır: yalnızca var/yok (ve bağlantı adresiyse ayrıştırılabilirlik). Değer dönmez. */
function secret(
  env: Env,
  key: string,
  label: string,
  group: ConfigGroup,
  options: { url?: boolean; required?: boolean; note?: string } = {},
): ConfigEntry {
  const value = raw(env, key);
  let state: ConfigState = value === undefined ? "missing" : "set";
  if (value !== undefined && options.url) {
    try {
      new URL(value);
    } catch {
      state = "invalid";
    }
  }
  return { key, label, group, secret: true, state, value: null, note: options.note };
}

/** Sır olmayan açık/kapalı bayrak: etkin değer kodun okuduğu fonksiyondan. */
function flag(
  env: Env,
  key: string,
  label: string,
  group: ConfigGroup,
  effective: boolean,
  note?: string,
): ConfigEntry {
  const value = raw(env, key);
  const valid = value === undefined || ["true", "false"].includes(value.toLowerCase());
  return {
    key,
    label,
    group,
    secret: false,
    state: value === undefined ? "default" : valid ? "set" : "invalid",
    value: onOff(effective),
    note,
  };
}

function plain(
  env: Env,
  key: string,
  label: string,
  group: ConfigGroup,
  note?: string,
): ConfigEntry {
  const value = raw(env, key);
  return {
    key,
    label,
    group,
    secret: false,
    state: value === undefined ? "missing" : "set",
    value: value ?? null,
    note,
  };
}

function positiveIntSetting(
  env: Env,
  key: string,
  label: string,
  group: ConfigGroup,
  effective: number,
  note?: string,
): ConfigEntry {
  const value = raw(env, key);
  const valid = value === undefined || /^[1-9][0-9]*$/.test(value);
  return {
    key,
    label,
    group,
    secret: false,
    state: value === undefined ? "default" : valid ? "set" : "invalid",
    value: String(effective),
    note,
  };
}

function ga4MeasurementState(env: Env): ConfigState {
  const value = raw(env, "GA4_MEASUREMENT_ID");
  if (value === undefined) return "missing";
  return parseMeasurementId(value) === null ? "invalid" : "set";
}

/** GA4 Data API ayarı: tanımsız / geçersiz / tanımlı. Değer asla dönmez. */
function ga4ApiState(env: Env, key: string): ConfigState {
  if (raw(env, key) === undefined) return "missing";
  const result = ga4ApiConfigFromEnv(env);
  return result.status === "invalid" && result.problems.includes(key) && raw(env, key) !== undefined
    ? "invalid"
    : "set";
}

/** Etkin GA4 kimlik kipi (değer yok, yalnızca kip). */
function ga4AuthNote(env: Env): string {
  const result = ga4ApiConfigFromEnv(env);
  if (result.status === "ready") {
    return result.config.auth.mode === "federated"
      ? "Kip: federe (anahtarsız)"
      : "Kip: özel anahtar (yedek)";
  }
  if (
    result.status === "invalid" &&
    result.problems.includes(GA4_ENV.privateKey) &&
    result.problems.includes(GA4_ENV.wifAudience)
  ) {
    return "Kip: çakışma (anahtar ve federe kimlik birlikte)";
  }
  return "Kip: hazır değil";
}

const FX = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 6 });

export function getConfigView(actor: AdminActor, env: Env = process.env): ConfigView {
  assertCapability(actor, "config.read");

  const fxRaw = raw(env, LLM_COST_FX_ENV);
  const fx = parseFxMicros(fxRaw);
  const embeddingRaw = raw(env, "EMBEDDING_COST_MICROS_PER_1K_TOKENS");
  const embeddingValid = embeddingRaw === undefined || /^[0-9]+$/.test(embeddingRaw);
  const freeRaw = raw(env, "FREE_SEARCHES_BEFORE_LOGIN");
  const freeValid = freeRaw === undefined || /^[0-9]+$/.test(freeRaw);
  const realtimeFlag = raw(env, "GEMINI_REALTIME_ENABLED")?.toLowerCase() === "true";
  const geminiKey = raw(env, "GEMINI_API_KEY") !== undefined;
  const chatOn = isChatDiscoveryEnabled(env);
  const chatImageFlag = raw(env, "CHAT_IMAGE_ENABLED") === "true";
  const testRecipients = (raw(env, "MARKETING_TEST_RECIPIENTS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const entries: ConfigEntry[] = [
    // --- Ürün ve erişim ---
    {
      key: "PRODUCT_ACCESS",
      label: "Ürün erişimi",
      group: "product",
      secret: false,
      state: raw(env, "PRODUCT_ACCESS") === undefined ? "default" : "set",
      value: isProductOpen(env) ? "Herkese açık" : "Kapalı (yalnızca yönetici önizlemesi)",
    },
    flag(
      env,
      "HOMEPAGE_DEMO_CONTENT",
      "Ana sayfa demo içeriği",
      "product",
      raw(env, "HOMEPAGE_DEMO_CONTENT") === "true",
    ),
    {
      key: "FREE_SEARCHES_BEFORE_LOGIN",
      label: "Girişsiz serbest arama",
      group: "product",
      secret: false,
      state: freeRaw === undefined ? "default" : freeValid ? "set" : "invalid",
      value: freeValid ? String(freeRaw ?? 3) : "Geçersiz (sayı değil)",
      note: "Günlük, oturum başına",
    },
    // --- AI ve arama ---
    secret(env, "GEMINI_API_KEY", "Gemini API anahtarı", "ai"),
    flag(
      env,
      "GEMINI_REALTIME_ENABLED",
      "Anlık sorgu yorumu",
      "ai",
      isRealtimeInterpretationEnabled(env),
      realtimeFlag && !geminiKey ? "Bayrak açık ama anahtar yok: etkin değil" : undefined,
    ),
    flag(env, "CHAT_DISCOVERY_ENABLED", "Konuşmalı keşif (sohbet)", "ai", chatOn),
    flag(
      env,
      "CHAT_IMAGE_ENABLED",
      "Sohbette görsel eki",
      "ai",
      isChatImageEnabled(env),
      chatImageFlag && !chatOn ? "Sohbet kapalıyken görsel eki de kapalı" : undefined,
    ),
    positiveIntSetting(
      env,
      "CHAT_TURNS_PER_HOUR",
      "Sohbet mesajı (saatlik, kişi başı)",
      "ai",
      chatTurnsPerHour(env),
      `Varsayılan ${DEFAULT_CHAT_TURNS_PER_HOUR}, üst sınır 200`,
    ),
    positiveIntSetting(
      env,
      "AI_SEARCH_DAILY_LIMIT",
      "Arama hakkı (günlük)",
      "ai",
      dailySearchLimit(env as NodeJS.ProcessEnv),
      `Varsayılan ${DEFAULT_DAILY_SEARCH_LIMIT}; yalnızca acil durum ayarı`,
    ),
    {
      key: LLM_COST_FX_ENV,
      label: "Gemini maliyet kuru (TRY/USD)",
      group: "ai",
      secret: false,
      state: fxRaw === undefined ? "missing" : fx === null ? "invalid" : "set",
      value: fx === null ? null : FX.format(fx / 1_000_000),
      note:
        fx === null
          ? "Tanımsız/geçersizken Gemini maliyeti fiyatlanmaz"
          : "Tahmin içindir, fatura değil",
    },
    {
      key: "EMBEDDING_COST_MICROS_PER_1K_TOKENS",
      label: "Embedding maliyeti (TRY-mikro / 1K token)",
      group: "ai",
      secret: false,
      state: embeddingRaw === undefined ? "default" : embeddingValid ? "set" : "invalid",
      value: embeddingValid ? (embeddingRaw ?? "0") : "0",
      note: "0 = fiyatlanmamış; Python işleri kendi ortamını okur",
    },
    secret(env, "JINA_API_KEY", "Embedding sağlayıcı anahtarı", "ai"),
    flag(
      env,
      "EMBEDDING_FAKE_CLIENT",
      "Sahte embedding istemcisi (yalnızca geliştirme)",
      "ai",
      raw(env, "EMBEDDING_FAKE_CLIENT") === "true",
    ),
    flag(
      env,
      "CHAT_TIMING_LOG",
      "Sohbet gecikme günlüğü",
      "ai",
      raw(env, "CHAT_TIMING_LOG") === "true",
    ),
    {
      key: "MATCH_AUTO_ACCEPT_THRESHOLD",
      label: "Eşleştirme otomatik kabul eşiği",
      group: "ai",
      secret: false,
      state: "unknown",
      value: null,
      note: "Yalnızca Python işleri okur; web sürecinden görülemez",
    },
    {
      key: "MATCH_QUEUE_THRESHOLD",
      label: "Eşleştirme kuyruk eşiği",
      group: "ai",
      secret: false,
      state: "unknown",
      value: null,
      note: "Yalnızca Python işleri okur; web sürecinden görülemez",
    },
    // --- Trafik ölçümü (GA4, karar 0087) ---
    {
      key: "GA4_MEASUREMENT_ID",
      label: "GA4 ölçüm kimliği (toplama)",
      group: "analytics",
      // Sayfa HTML'inde zaten görünür: sır değil.
      secret: false,
      state: ga4MeasurementState(env),
      value: parseMeasurementId(raw(env, "GA4_MEASUREMENT_ID")),
      note:
        parseMeasurementId(raw(env, "GA4_MEASUREMENT_ID")) === null
          ? "Tanımsız/geçersizken betik yüklenmez, CSP genişlemez"
          : "Yalnızca analitik rızasıyla yüklenir; değişince yeniden dağıtım gerekir",
    },
    {
      key: GA4_ENV.propertyId,
      label: "GA4 mülk kimliği (raporlama)",
      group: "analytics",
      secret: false,
      state: ga4ApiState(env, GA4_ENV.propertyId),
      value:
        ga4ApiState(env, GA4_ENV.propertyId) === "set"
          ? (raw(env, GA4_ENV.propertyId) ?? null)
          : null,
    },
    {
      key: GA4_ENV.clientEmail,
      label: "GA4 servis hesabı",
      group: "analytics",
      secret: true,
      state: ga4ApiState(env, GA4_ENV.clientEmail),
      value: null,
      note: `Mülkte yalnızca Görüntüleyici; kapsam analytics.readonly. ${ga4AuthNote(env)}`,
    },
    {
      key: GA4_ENV.wifAudience,
      label: "GA4 federe kimlik (Workload Identity Federation)",
      group: "analytics",
      // Sağlayıcı kaynak adı: sır değil, kimlik vermez.
      secret: false,
      state: ga4ApiState(env, GA4_ENV.wifAudience),
      value:
        ga4ApiState(env, GA4_ENV.wifAudience) === "set"
          ? (raw(env, GA4_ENV.wifAudience) ?? null)
          : null,
      note: "Önerilen kip: çalışma ortamının OIDC belirteciyle anahtarsız erişim (karar 0088)",
    },
    {
      key: GA4_ENV.privateKey,
      label: "GA4 servis hesabı özel anahtarı",
      group: "analytics",
      secret: true,
      state: ga4ApiState(env, GA4_ENV.privateKey),
      value: null,
      note: "Yalnızca taşınabilirlik yedeği; federe kimlikle birlikte tanımlanamaz",
    },
    {
      key: GA4_ENV.testApiBaseUrl,
      label: "GA4 sahte uç nokta (yalnızca yerel test)",
      group: "analytics",
      secret: false,
      state: ga4ApiState(env, GA4_ENV.testApiBaseUrl),
      value: null,
      note:
        raw(env, GA4_ENV.testApiBaseUrl) !== undefined
          ? "Tanımlı: raporlar gerçek GA4'ten gelmiyor"
          : "Üretimde tanımsız olmalı",
    },
    // --- E-posta ---
    flag(
      env,
      "MARKETING_EMAIL_ENABLED",
      "Pazarlama e-postası gerçek gönderimi",
      "email",
      raw(env, "MARKETING_EMAIL_ENABLED")?.toLowerCase() === "true",
      "Üretimde ayrıca gönderen adresi gerekir",
    ),
    plain(env, "EMAIL_FROM", "Gönderen (işlemsel)", "email"),
    plain(env, "MARKETING_EMAIL_FROM", "Gönderen (pazarlama)", "email"),
    {
      key: "MARKETING_TEST_RECIPIENTS",
      label: "Test alıcı izin listesi",
      group: "email",
      // Kişisel e-posta adresleri: değer değil, yalnızca sayı.
      secret: true,
      state: testRecipients.length === 0 ? "missing" : "set",
      value: null,
      note: testRecipients.length > 0 ? `${testRecipients.length} adres` : undefined,
    },
    secret(env, "SMTP_HOST", "SMTP sunucusu", "email"),
    secret(env, "SMTP_USER", "SMTP kullanıcısı", "email"),
    secret(env, "SMTP_PASS", "SMTP parolası", "email"),
    // --- Kimlik ---
    secret(env, "SESSION_SECRET", "Oturum imza anahtarı", "auth"),
    secret(env, "CRON_SECRET", "Zamanlanmış iş anahtarı", "auth"),
    secret(env, "GOOGLE_CLIENT_ID", "Google istemci kimliği", "auth"),
    secret(env, "GOOGLE_CLIENT_SECRET", "Google istemci sırrı", "auth"),
    secret(env, "APPLE_CLIENT_ID", "Apple istemci kimliği", "auth"),
    secret(env, "APPLE_TEAM_ID", "Apple takım kimliği", "auth"),
    secret(env, "APPLE_KEY_ID", "Apple anahtar kimliği", "auth"),
    secret(env, "APPLE_PRIVATE_KEY", "Apple özel anahtarı", "auth"),
    plain(env, "SMS_PROVIDER", "SMS sağlayıcısı", "auth"),
    secret(env, "NETGSM_USERCODE", "Netgsm kullanıcı kodu", "auth"),
    secret(env, "NETGSM_PASSWORD", "Netgsm parolası", "auth"),
    plain(env, "PHONE_ALLOWED_COUNTRY_CODES", "Telefonla giriş ülke kodları", "auth"),
    plain(env, "SESSION_TTL_DAYS", "Oturum ömrü (gün)", "auth", "Tanımsızsa kod varsayılanı"),
    plain(
      env,
      "AUTH_TOKEN_TTL_MINUTES",
      "Giriş bağlantısı ömrü (dk)",
      "auth",
      "Tanımsızsa kod varsayılanı",
    ),
    // --- Altyapı ---
    secret(env, "DATABASE_URL", "Veritabanı bağlantısı", "infrastructure", { url: true }),
    secret(env, "REDIS_URL", "Redis bağlantısı", "infrastructure", { url: true }),
    secret(env, "R2_ACCOUNT_ID", "Nesne deposu hesabı", "infrastructure"),
    secret(env, "R2_ACCESS_KEY_ID", "Nesne deposu erişim anahtarı", "infrastructure"),
    secret(env, "R2_SECRET_ACCESS_KEY", "Nesne deposu gizli anahtarı", "infrastructure"),
    secret(env, "R2_BUCKET_NAME", "Nesne deposu kovası", "infrastructure"),
    plain(env, "R2_PUBLIC_BASE_URL", "Medya genel adresi", "infrastructure"),
    plain(env, "APP_URL", "Uygulama adresi", "infrastructure", "Tanımsızsa Vercel üretim adresi"),
    // --- Çalışma ortamı ---
    plain(env, "VERCEL_ENV", "Vercel ortamı", "runtime"),
    plain(env, "NODE_ENV", "Node ortamı", "runtime"),
  ];

  return {
    entries,
    quotas: Object.entries(QUOTA_POLICY).map(([pool, limits]) => ({
      pool,
      windows: QUOTA_WINDOWS.map((window) => ({ window, limit: limits[window] })),
    })),
    caps: [
      {
        key: "CHAT_DAILY_CALL_CAP",
        label: "Sohbet, günlük Gemini çağrısı",
        value: CHAT_DAILY_CALL_CAP,
      },
      {
        key: "REALTIME_INTERPRETATION_DAILY_CALL_CAP",
        label: "Anlık yorum, günlük Gemini çağrısı",
        value: REALTIME_INTERPRETATION_DAILY_CALL_CAP,
      },
      {
        key: "QUERY_INTERPRETATION_DAILY_CALL_CAP",
        label: "Toplu yorum, günlük Gemini çağrısı",
        value: QUERY_INTERPRETATION_DAILY_CALL_CAP,
      },
      ...AI_SEARCH_RATE_LIMITS.map((limit) => ({
        key: `AI_SEARCH_RATE_LIMITS.${limit.name}`,
        label: `Pahalı arama isteği (${limit.windowSeconds} sn)`,
        value: limit.max,
      })),
      { key: "BONUS_BALANCE_MAX", label: "Bonus bakiye tavanı", value: BONUS_BALANCE_MAX },
    ],
  };
}
