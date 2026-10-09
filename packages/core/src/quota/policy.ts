/**
 * Kullanici kotalarinin TEK kaynagi: hangi islem hangi havuzdan, hangi
 * pencerede ne kadar harcar. Saf sabitler; istemci bilesenleri de
 * (`@arilla/core/quota-policy`) okuyabilir, sunucu kodu ya da ortam okumaz.
 *
 * Dort pencere de Europe/Istanbul takvimine baglidir (saat basi, gece 00:00,
 * pazartesi 00:00, ayin 1'i 00:00); kayan pencere degildir. Bkz. `windows.ts`.
 *
 * Bu tablo KULLANICI urun kotasidir. Saglayici guvenlik tavanlari (gunluk
 * toplam cagri: `REALTIME_INTERPRETATION_DAILY_CALL_CAP`, `CHAT_DAILY_CALL_CAP`)
 * ve kotuye kullanim oran sinirlari (`AI_SEARCH_RATE_LIMITS`: dakikada 3) ayri
 * kalir ve bu tablodan gevsetilmez.
 */

export const QUOTA_WINDOWS = ["hour", "day", "week", "month"] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export type WindowLimits = Readonly<Record<QuotaWindow, number>>;

export const QUOTA_POOLS = [
  /** Fotograf aramasi ve (acildiginda) link aramasi: ayni havuz, "arama hakki". */
  "search_rights",
  /** Kullanicinin gonderdigi her sohbet mesaji (metin, secenek, atla). */
  "chat_message",
  /** Anlik Gemini sorgu yorumu, girisli kullanici. */
  "realtime_interpretation_user",
  /** Anlik Gemini sorgu yorumu, anonim ziyaretci (IP ozeti). */
  "realtime_interpretation_anonymous",
] as const;
export type QuotaPool = (typeof QUOTA_POOLS)[number];

export const QUOTA_POLICY: Readonly<Record<QuotaPool, WindowLimits>> = {
  search_rights: { hour: 10, day: 30, week: 120, month: 350 },
  chat_message: { hour: 20, day: 60, week: 300, month: 900 },
  realtime_interpretation_user: { hour: 30, day: 100, week: 400, month: 1000 },
  realtime_interpretation_anonymous: { hour: 30, day: 60, week: 200, month: 500 },
};

/**
 * Hak harcayan islemlerin havuzu. Link aramasi su an kapali
 * (`LINK_SEARCH_PUBLIC`); acildiginda fotografla AYNI havuzdan harcar.
 */
export const SEARCH_RIGHTS_OPERATIONS = ["visual_search", "link_search"] as const;

/**
 * Bonus hakkin asabildigi pencereler. Saatlik pencere bir patlama sinirdir:
 * bonus onu asamaz. Gun/hafta/ay dolunca kalan bonus harcanir.
 */
export const BONUS_COVERS_WINDOWS: readonly QuotaWindow[] = ["day", "week", "month"];
