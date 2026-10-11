/**
 * Internet urun aramasi yapilandirmasi (docs/decisions/0102).
 *
 * Bayrak varsayilan KAPALI. Uretimde ek olarak hukuki onay bayragi gerekir:
 * onaysiz uretimde yeni Gemini veri akisi acilmaz (karar 0095 kisitlari).
 * Kapaliyken sistem davranisi degismez: bu modul hicbir yan etki uretmez.
 */

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Google Search grounding + URL Context destekleyen model. Mevcut yorum modeli
 * (`gemini-3.1-flash-lite`) dokumanda arama grounding'i icin LISTELENMEZ
 * (URL Context icin listelenir); bu yuzden bu akis ayri, incelenmis bir sabit
 * kullanir. Kullanici ya da ortam degistiremez.
 */
export const WEB_SEARCH_MODEL = "gemini-3.5-flash-lite";
/** Grounding araclari su an yalnizca `v1beta` Interactions uc noktasinda belgelidir. */
export const WEB_SEARCH_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** `api_usage.operation`. Diger Gemini akislarindan ayri sayilir. */
export const WEB_SEARCH_OPERATION = "web_search_grounded";

/** `quota/provider-budget.ts` islem anahtari (api_usage.operation degildir). */
export const WEB_SEARCH_BUDGET_KEY = "web_search" as const;

/** Europe/Istanbul gunu basina saglayici HTTP denemesi (tum kullanicilar). */
export const WEB_SEARCH_DAILY_CALL_CAP = 300;

/** Tek deneme; grounding aramalari yorum cagrisindan yavastir ama kullanici bekler. */
export const WEB_SEARCH_TIMEOUT_MS = 14_000;
export const WEB_SEARCH_MAX_OUTPUT_TOKENS = 3_072;

/** Kisi basina (girisli hesap ya da IP ozeti) gercek model cagrisi. */
export const WEB_SEARCH_ACTOR_LIMITS = { hour: 8, day: 30 } as const;

export const WEB_SEARCH_CACHE_TTL_SECONDS = 6 * 60 * 60;
/** Sonucsuz arama kisa onbelleklenir: ayni bos sorgu tekrar odeme olmasin. */
export const WEB_SEARCH_EMPTY_CACHE_TTL_SECONDS = 30 * 60;
export const WEB_SEARCH_FLIGHT_TTL_MS = 20_000;

/** Cikis baglantisinin (imzali) gecerlilik suresi; sonuc onbellegiyle uyumlu. */
export const WEB_EXIT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export const WEB_SEARCH_MAX_GROUPS = 8;
export const WEB_SEARCH_MAX_OFFERS_PER_GROUP = 5;
/** Modelden istenen en fazla aday; fazlasi dogrulama maliyetini artirir. */
export const WEB_SEARCH_MAX_CANDIDATES = 12;

export function isProductionEnv(env: Env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production";
  return env.NODE_ENV === "production";
}

/**
 * `WEB_SEARCH_ENABLED=true` + `GEMINI_API_KEY`; uretimde ayrica
 * `WEB_SEARCH_LEGAL_APPROVED=true` (hukuki onay verildikten sonra elle acilir).
 */
export function isWebSearchEnabled(env: Env = process.env): boolean {
  if (env.WEB_SEARCH_ENABLED?.trim().toLowerCase() !== "true") return false;
  if (!env.GEMINI_API_KEY?.trim()) return false;
  if (isProductionEnv(env) && env.WEB_SEARCH_LEGAL_APPROVED?.trim().toLowerCase() !== "true") {
    return false;
  }
  return true;
}
