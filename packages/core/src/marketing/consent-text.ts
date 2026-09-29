/**
 * Pazarlama e-postası rıza metni — sürümlü tek kaynak (docs/decisions/0046).
 *
 * Her rıza satırı kabul edilen metnin `version` değerini taşır
 * (`user_consent.text_version`). Metin DEĞİŞTİĞİNDE sürüm de değişir ve eski
 * sürüm aşağıdaki geçmişe eklenir: bir satırın hangi cümleye verildiği her
 * zaman kanıtlanabilir olmalı. Metin hukukçu onayından geçmedi; onaydan sonra
 * yalnızca bu dosya değişir.
 *
 * Kullanım koşulları / gizlilik kabulüyle BİRLEŞTİRİLMEZ: ayrı, işaretsiz
 * gelen, isteğe bağlı bir kutudur.
 */
export interface ConsentText {
  version: string;
  text: string;
}

export const MARKETING_EMAIL_CONSENT_TEXT: ConsentText = {
  version: "marketing-email.2026-09-29.v1",
  text: "ManiCepte’den ürün yenilikleri, kampanyalar ve pazarlama içerikli e-postalar almak istiyorum.",
};

/** Yayından kalkmış sürümler (en yeni üstte). Denetim için silinmez. */
export const MARKETING_EMAIL_CONSENT_TEXT_HISTORY: readonly ConsentText[] = [
  MARKETING_EMAIL_CONSENT_TEXT,
];

/** Rızanın alındığı yerler. `user_consent_source_check` ile aynı küme. */
export const MARKETING_OPT_IN_SOURCES = [
  "signup",
  "early_access",
  "account_settings",
  "feedback",
  "admin_import",
] as const;
export type MarketingOptInSource = (typeof MARKETING_OPT_IN_SOURCES)[number];

export const MARKETING_OPT_OUT_SOURCES = ["account_settings", "unsubscribe_link", "iys"] as const;
export type MarketingOptOutSource = (typeof MARKETING_OPT_OUT_SOURCES)[number];

export function isKnownConsentTextVersion(version: string): boolean {
  return MARKETING_EMAIL_CONSENT_TEXT_HISTORY.some((entry) => entry.version === version);
}
