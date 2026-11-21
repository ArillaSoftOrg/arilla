/**
 * GTM + Consent Mode v2 + dataLayer olayları (karar 0219). Saf fonksiyonlar: ağ,
 * Node ve veritabanı bağımlılığı yok; istemci `@arilla/core/gtm` alt yolundan import eder.
 *
 * İlke: izin listesi. Olay adları ve parametre anahtarları sabit sözlüktür (GTM
 * tetikleyicisi bu adlara göre regex ile eşleşir). Kişisel veri (sohbet metni,
 * e-posta, telefon, ad, kullanıcı kimliği, IP) hiçbir parametreye girmez.
 */

const GTM_ID = /^GTM-[A-Z0-9]{6,10}$/;
const CLARITY_ID = /^[a-z0-9]{8,12}$/;

/** Geçerli bir GTM kapsayıcı kimliği ise kendisi, değilse `null`. */
export function parseGtmId(raw: string | undefined | null): string | null {
  const value = raw?.trim().toUpperCase() ?? "";
  return GTM_ID.test(value) ? value : null;
}

/**
 * `GTM_LOAD_BEFORE_CONSENT` (karar 0219): varsayılan `true` (GTM, Consent Mode denied
 * varsayılanıyla rızadan önce yüklenir). `false`/`0`/`off` ise GTM ve GA4 yalnızca
 * analitik rızasından sonra yüklenir.
 */
export function gtmLoadsBeforeConsent(raw: string | undefined | null): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  return !["false", "0", "off", "no"].includes(value);
}

/** Geçerli bir Clarity proje kimliği ise kendisi, değilse `null`. */
export function parseClarityId(raw: string | undefined | null): string | null {
  const value = raw?.trim().toLowerCase() ?? "";
  return CLARITY_ID.test(value) ? value : null;
}

/** CSP kökenleri (karar 0219). Clarity kökenleri yalnızca Clarity açıkken eklenir. */
export const GTM_SCRIPT_ORIGIN = "https://www.googletagmanager.com";
export const GTM_CONNECT_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.g.doubleclick.net",
] as const;
export const GTM_FRAME_ORIGIN = "https://www.googletagmanager.com";
export const CLARITY_SCRIPT_ORIGIN = "https://www.clarity.ms";
export const CLARITY_CONNECT_ORIGINS = ["https://*.clarity.ms", "https://c.bing.com"] as const;

/** Consent Mode v2: reklam sinyalleri kalıcı `denied`; yalnızca analitik değişir. */
export type ConsentValue = "granted" | "denied";
export interface ConsentModeState {
  ad_storage: "denied";
  ad_user_data: "denied";
  ad_personalization: "denied";
  analytics_storage: ConsentValue;
}

export function consentModeState(analyticsGranted: boolean): ConsentModeState {
  return {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: analyticsGranted ? "granted" : "denied",
  };
}

export const CONSENT_WAIT_FOR_UPDATE_MS = 500;

/**
 * `<head>` içine GTM'den ÖNCE basılan satır içi betik: varsayılan hepsi `denied`;
 * sunucunun okuduğu önceki tercih (çerez) varsa GTM yüklenmeden güncellenir.
 * Yalnızca sabit değerler içerir (kullanıcı girdisi yok).
 */
export function consentBootstrapScript(analyticsGranted: boolean): string {
  const defaults = JSON.stringify({
    ...consentModeState(false),
    wait_for_update: CONSENT_WAIT_FOR_UPDATE_MS,
  });
  const update = analyticsGranted
    ? `gtag("consent","update",${JSON.stringify(consentModeState(true))});`
    : "";
  return (
    "window.dataLayer=window.dataLayer||[];" +
    "function gtag(){dataLayer.push(arguments);}" +
    `gtag("consent","default",${defaults});` +
    update
  );
}

/** Resmi GTM snippet'i (kimlik `parseGtmId` ile doğrulanmış olmalı). */
export function gtmSnippet(gtmId: string): string {
  return (
    "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});" +
    "var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';" +
    "j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);" +
    `})(window,document,'script','dataLayer','${gtmId}');`
  );
}

/** dataLayer'a giren tüm anahtarlar; her push'ta açıkça sıfırlanır (GTM değer taşır). */
export const GTM_PARAM_KEYS = [
  "search_term",
  "item_id",
  "item_name",
  "item_category",
  "store_name",
  "method",
  "category_name",
  "interaction_type",
  "compared_count",
] as const;
export type GtmParamKey = (typeof GTM_PARAM_KEYS)[number];

export type AiChatInteraction = "user_message" | "suggestion_click";

interface ItemParams {
  item_id: string;
  item_name?: string;
  item_category?: string;
  store_name?: string;
}

/** Olay adı → izin verilen parametreler. GTM regex tetikleyicisi bu adlara bağlıdır. */
export interface GtmEventMap {
  search: { search_term: string };
  ai_chat_start: { interaction_type: string };
  ai_chat_message: { interaction_type: AiChatInteraction };
  view_item: ItemParams;
  compare_products: { compared_count: number; item_id?: string };
  store_redirect_click: Pick<ItemParams, "item_id" | "item_name" | "store_name">;
  sign_up: { method: string };
  login: { method: string };
  save_item: ItemParams;
  remove_saved_item: ItemParams;
  select_category: { category_name: string };
  discover_interaction: { interaction_type: string; category_name?: string };
  early_access_signup: { method: string };
}
export type GtmEventName = keyof GtmEventMap;

/** İzin listesi: bu adların dışında bir olay üretilmez. */
export const GTM_EVENT_PARAMS: Readonly<Record<GtmEventName, readonly GtmParamKey[]>> = {
  search: ["search_term"],
  ai_chat_start: ["interaction_type"],
  ai_chat_message: ["interaction_type"],
  view_item: ["item_id", "item_name", "item_category", "store_name"],
  compare_products: ["compared_count", "item_id"],
  store_redirect_click: ["item_id", "item_name", "store_name"],
  sign_up: ["method"],
  login: ["method"],
  save_item: ["item_id", "item_name", "item_category", "store_name"],
  remove_saved_item: ["item_id", "item_name", "item_category", "store_name"],
  select_category: ["category_name"],
  discover_interaction: ["interaction_type", "category_name"],
  early_access_signup: ["method"],
};

const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;
// 7+ rakam (boşluk, tire, parantez, + serbest): telefon benzeri.
const PHONE_LIKE = /(?:\+?\d[\s().-]*){7,}/;
const SEARCH_TERM_MAX = 100;
const TEXT_MAX = 120;

/**
 * search_term: küçük harf (tr), kırp, ≤100 karakter. E-posta/telefon benzeri
 * desen içeriyorsa `null` (hiç gönderilmez).
 */
export function sanitizeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  if (value === "") return null;
  if (EMAIL_LIKE.test(value) || PHONE_LIKE.test(value)) return null;
  return value.slice(0, SEARCH_TERM_MAX);
}

/** Ürün/mağaza/kategori adı gibi kısa etiketler: kırp, sınırla, e-posta desenini düşür. */
export function sanitizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "" || EMAIL_LIKE.test(value)) return null;
  return value.slice(0, TEXT_MAX);
}

/** Kalıcı ürün kimliği: yalnızca kısa, güvenli karakterler (fiyat/kullanıcıya özel değer değil). */
export function sanitizeItemId(raw: unknown): string | null {
  const value = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export type DataLayerPush = { event: GtmEventName } & Record<GtmParamKey, string | number | null>;

const ITEM_EVENTS: readonly GtmEventName[] = [
  "view_item",
  "store_redirect_click",
  "save_item",
  "remove_saved_item",
];

/**
 * Tek push biçimi: olay adı + 9 anahtarın HEPSİ (kullanılmayan `null`). GTM veri
 * katmanı değerleri sonraki push'lara taşıdığı için sıfırlama zorunludur. Değerler
 * izin listesine ve arındırmaya tabidir. Zorunlu değer (arama metni, ürün kimliği)
 * geçersizse `null` döner: olay hiç gönderilmez.
 */
export function buildDataLayerPush<N extends GtmEventName>(
  name: N,
  params: GtmEventMap[N],
): DataLayerPush | null {
  const allowed = GTM_EVENT_PARAMS[name];
  if (!allowed) return null;
  const input = params as Partial<Record<GtmParamKey, unknown>>;
  const out = Object.fromEntries(GTM_PARAM_KEYS.map((k) => [k, null])) as Record<
    GtmParamKey,
    string | number | null
  >;
  for (const key of allowed) {
    const raw = input[key];
    switch (key) {
      case "search_term":
        out[key] = sanitizeSearchTerm(raw);
        break;
      case "item_id":
        out[key] = sanitizeItemId(raw);
        break;
      case "compared_count":
        out[key] =
          typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : null;
        break;
      default:
        out[key] = sanitizeLabel(raw);
    }
  }
  if (name === "search" && out.search_term === null) return null;
  if (ITEM_EVENTS.includes(name) && out.item_id === null) return null;
  return { event: name, ...out };
}
