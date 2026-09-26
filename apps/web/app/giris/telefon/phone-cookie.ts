/**
 * Iki adim arasinda numara URL'de degil httpOnly cerezde tasinir: kisisel
 * veri sorgu dizesine, gecmise ve sunucu loglarina yazilmaz.
 */
export const PHONE_COOKIE = "phone_login";
export const PHONE_COOKIE_PATH = "/giris/telefon";
export const PHONE_COOKIE_MAX_AGE_SECONDS = 15 * 60;
