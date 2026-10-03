/**
 * `/geri-bildirim` form dogrulamasi (docs/decisions/0045). Saf fonksiyon:
 * Redis'e ve veritabanina dokunmaz, birim testlidir.
 *
 * Girdi guvenilmezdir. Kurallar:
 * - Yalnizca bilinen alanlar kabul edilir; bilinmeyen alan (orn. istemcinin
 *   gonderdigi `user_id`) formu reddeder. Next'in progressive enhancement
 *   icin ekledigi `$ACTION_*` alanlari yok sayilir.
 * - Ayni alan iki kez gelirse ya da deger metin degilse (dosya) reddedilir.
 * - Metinlerden NUL ve diger kontrol karakterleri atilir (Postgres `text`
 *   NUL kabul etmez); satir sonu ve sekme korunur.
 * - Uzunluk Unicode kod noktasi olarak olculur (Postgres `char_length` ile ayni).
 * - Girisli kullanicida `email` alani yok sayilir: e-posta yalnizca oturumdaki
 *   hesaptan gelir.
 */
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_PRIORITIES,
  type FeedbackCategory,
  type FeedbackPriority,
} from "@arilla/db";

export const FEEDBACK_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  messageMin: 10,
  messageMax: 5000,
  emailMax: 254,
  /** Tum alanlarin toplam uzunlugu; tek tek sinirlarin ustunde kaba bir tavan. */
  payloadMax: 6000,
} as const;

export const FEEDBACK_FIELDS = ["category", "title", "message", "priority", "email"] as const;
export type FeedbackField = (typeof FEEDBACK_FIELDS)[number];

export type FeedbackFieldError = "required" | "invalid" | "too_short" | "too_long";

export interface FeedbackInput {
  category: FeedbackCategory;
  title: string;
  message: string;
  priority: FeedbackPriority | null;
  /** Yalnizca anonim gonderimde dolu olabilir. */
  email: string | null;
}

export type FeedbackValidation =
  | { ok: true; value: FeedbackInput }
  | {
      ok: false;
      fieldErrors: Partial<Record<FeedbackField, FeedbackFieldError>>;
      /** Alan duzeyine baglanamayan ret: bilinmeyen alan ya da asiri buyuk govde. */
      formError?: "malformed" | "too_large";
    };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: kontrol karakterlerini atmak icin.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").trim();
}

function isKnownField(key: string): key is FeedbackField {
  return (FEEDBACK_FIELDS as readonly string[]).includes(key);
}

function lengthError(value: string, min: number, max: number): FeedbackFieldError | undefined {
  if (value === "") return "required";
  const length = codePoints(value);
  if (length < min) return "too_short";
  if (length > max) return "too_long";
  return undefined;
}

export function validateFeedback(
  entries: Iterable<[string, unknown]>,
  options: { authenticated: boolean },
): FeedbackValidation {
  const raw = new Map<FeedbackField, string>();
  let total = 0;
  for (const [key, value] of entries) {
    if (key.startsWith("$ACTION")) continue;
    if (!isKnownField(key) || raw.has(key) || typeof value !== "string") {
      return { ok: false, fieldErrors: {}, formError: "malformed" };
    }
    total += value.length;
    if (total > FEEDBACK_LIMITS.payloadMax) {
      return { ok: false, fieldErrors: {}, formError: "too_large" };
    }
    raw.set(key, value);
  }

  const fieldErrors: Partial<Record<FeedbackField, FeedbackFieldError>> = {};

  const categoryRaw = clean(raw.get("category") ?? "");
  const category = (FEEDBACK_CATEGORIES as readonly string[]).includes(categoryRaw)
    ? (categoryRaw as FeedbackCategory)
    : null;
  if (!category) fieldErrors.category = categoryRaw === "" ? "required" : "invalid";

  const title = clean(raw.get("title") ?? "").replace(/\s+/g, " ");
  const titleError = lengthError(title, FEEDBACK_LIMITS.titleMin, FEEDBACK_LIMITS.titleMax);
  if (titleError) fieldErrors.title = titleError;

  const message = clean(raw.get("message") ?? "");
  const messageError = lengthError(message, FEEDBACK_LIMITS.messageMin, FEEDBACK_LIMITS.messageMax);
  if (messageError) fieldErrors.message = messageError;

  const priorityRaw = clean(raw.get("priority") ?? "");
  let priority: FeedbackPriority | null = null;
  if (priorityRaw !== "") {
    if ((FEEDBACK_PRIORITIES as readonly string[]).includes(priorityRaw)) {
      priority = priorityRaw as FeedbackPriority;
    } else {
      fieldErrors.priority = "invalid";
    }
  }

  let email: string | null = null;
  if (!options.authenticated) {
    const emailRaw = clean(raw.get("email") ?? "").toLowerCase();
    if (emailRaw !== "") {
      if (emailRaw.length > FEEDBACK_LIMITS.emailMax) {
        fieldErrors.email = "too_long";
      } else if (!EMAIL_PATTERN.test(emailRaw)) {
        fieldErrors.email = "invalid";
      } else {
        email = emailRaw;
      }
    }
  }

  if (!category || Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, value: { category, title, message, priority, email } };
}
