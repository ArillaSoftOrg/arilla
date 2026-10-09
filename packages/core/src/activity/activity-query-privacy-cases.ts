/**
 * Karar 0089: kullaniciya bagli arama metni icin ortak test girdileri (birim
 * ve entegrasyon testleri). Uretim kodundan import edilmez.
 */

/** Olay yazilir, `query_norm` NULL kalir. */
export const ACTIVITY_BLOCKED_QUERIES: readonly [string, string][] = [
  ["e-posta", "Ayse.Yilmaz@Gmail.com siyah elbise"],
  ["telefon", "0532 123 45 67"],
  ["URL", "https://shop.example.com/p?token=abc"],
  ["adres", "Atatürk Mah. Gül Sokak No: 12"],
  ["bolunmus kimlik", "tc 123 456 789 01"],
  ["API anahtari", "AIzaSyD-abcdefghijklmnopqrstuvwxyz12"],
  ["sk- anahtari", "sk-proj_abcdefgh"],
  ["password=", "password=hunter2"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"],
  ["saglik", "kanser tedavisi için peruk"],
  ["gebelik", "hamileyim elbise önerisi"],
  ["din", "alevi cem kıyafeti"],
  ["siyasi", "chp rozeti"],
  ["sabika", "sabıka kaydı sorgulama"],
];

/** `query_norm` bugunku gibi saklanir. */
export const ACTIVITY_STORED_QUERIES: readonly string[] = [
  "siyah elbise",
  "iphone 15 pro max kılıf",
  "nike air force 1 42 numara",
];
