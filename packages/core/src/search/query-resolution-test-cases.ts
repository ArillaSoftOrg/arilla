/**
 * `resolveQuery` gizlilik kapisi icin ortak test girdileri (birim ve
 * entegrasyon testleri). Uretim kodundan import edilmez.
 */
import type { IneligibleReason } from "./interpretation-eligibility.ts";

export interface BlockedQuery {
  label: string;
  raw: string;
  reason: IneligibleReason;
}

/** Engellenen girdiler ve `queryContentIneligibility`'nin bugunku nedeni. */
export const BLOCKED_QUERIES: readonly BlockedQuery[] = [
  { label: "e-posta", raw: "Ahmet.Yilmaz@Gmail.com siyah elbise", reason: "personal_data" },
  { label: "telefon", raw: "0532 123 45 67", reason: "personal_data" },
  { label: "7+ haneli rakam", raw: "12345678901", reason: "personal_data" },
  { label: "bolunmus kimlik", raw: "tc 123 456 789 01", reason: "id_like" },
  {
    label: "URL",
    raw: "https://shop.example.com/p?id=9&token=abcDEF123secret",
    reason: "personal_data",
  },
  { label: "API anahtari", raw: "AIzaSyD-abcdefghijklmnopqrstuvwxyz12", reason: "secret_like" },
  { label: "password=", raw: "password=hunter2", reason: "secret_like" },
  { label: "JWT", raw: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", reason: "secret_like" },
  { label: "adres", raw: "Atatürk Mah. Gül Sokak No: 12", reason: "personal_data" },
  { label: "ozel nitelikli", raw: "hamileyim siyah elbise", reason: "sensitive" },
];

export const NORMAL_QUERIES: readonly string[] = [
  "siyah elbise",
  "iphone 15 pro max kılıf",
  "nike air force 1 42 numara",
];
