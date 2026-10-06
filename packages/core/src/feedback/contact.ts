/**
 * `/iletisim` formu (docs/decisions/0061). Ayri bir gonderim sistemi DEGIL:
 * `/geri-bildirim` (karar 0045) ile ayni `feedback` tablosu (`kind =
 * 'contact'`), ayni oran siniri kotasi, ayni metin temizleme kurallari ve
 * ayni KVKK kapsami (hesap silinince silinir, veri indirmede yer alir).
 *
 * Sira: oturum (cagiran verir) -> dogrulama -> oran siniri -> INSERT.
 *
 * Geri bildirimden farklar:
 * - Ad ve e-posta ZORUNLU: iletisim mesaji yanit bekler. Girisli kullanicida
 *   da e-posta formdan gelir (hesapta e-posta olmayabilir ya da kullanici
 *   baska bir yanit adresi isteyebilir); hesap baglantisi `user_id` ile
 *   yalnizca oturumdan kurulur.
 * - Kategori `CONTACT_CATEGORIES`'ten; konu `title` kolonuna yazilir.
 *
 * Mesaj, ad ve e-posta asla loglanmaz; hata durumunda yalnizca hata kodu.
 */
import { CONTACT_CATEGORIES, type ContactCategory, type Database, feedback } from "@arilla/db";
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { consumeFeedbackQuota } from "./rate-limit.ts";
import {
  cleanFormText,
  FEEDBACK_LIMITS,
  type FeedbackFieldError,
  FORM_EMAIL_PATTERN,
  formLengthError,
} from "./validate.ts";

export const CONTACT_LIMITS = {
  nameMin: 2,
  nameMax: 100,
  subjectMin: 3,
  subjectMax: 120,
  messageMin: 10,
  messageMax: 5000,
  emailMax: FEEDBACK_LIMITS.emailMax,
  payloadMax: 6000,
} as const;

export const CONTACT_FORM_FIELDS = ["name", "email", "category", "subject", "message"] as const;
export type ContactFormField = (typeof CONTACT_FORM_FIELDS)[number];
export type ContactFormFieldError = FeedbackFieldError;

export interface ContactInput {
  name: string;
  email: string;
  category: ContactCategory;
  subject: string;
  message: string;
}

export type ContactValidation =
  | { ok: true; value: ContactInput }
  | {
      ok: false;
      fieldErrors: Partial<Record<ContactFormField, ContactFormFieldError>>;
      formError?: "malformed" | "too_large";
    };

function isKnownField(key: string): key is ContactFormField {
  return (CONTACT_FORM_FIELDS as readonly string[]).includes(key);
}

/** Saf fonksiyon; Redis'e ve veritabanina dokunmaz. */
export function validateContact(entries: Iterable<[string, unknown]>): ContactValidation {
  const raw = new Map<ContactFormField, string>();
  let total = 0;
  for (const [key, value] of entries) {
    if (key.startsWith("$ACTION")) continue;
    if (!isKnownField(key) || raw.has(key) || typeof value !== "string") {
      return { ok: false, fieldErrors: {}, formError: "malformed" };
    }
    total += value.length;
    if (total > CONTACT_LIMITS.payloadMax) {
      return { ok: false, fieldErrors: {}, formError: "too_large" };
    }
    raw.set(key, value);
  }

  const fieldErrors: Partial<Record<ContactFormField, ContactFormFieldError>> = {};

  const name = cleanFormText(raw.get("name") ?? "").replace(/\s+/g, " ");
  const nameError = formLengthError(name, CONTACT_LIMITS.nameMin, CONTACT_LIMITS.nameMax);
  if (nameError) fieldErrors.name = nameError;

  const email = cleanFormText(raw.get("email") ?? "").toLowerCase();
  if (email === "") {
    fieldErrors.email = "required";
  } else if (email.length > CONTACT_LIMITS.emailMax) {
    fieldErrors.email = "too_long";
  } else if (!FORM_EMAIL_PATTERN.test(email)) {
    fieldErrors.email = "invalid";
  }

  const categoryRaw = cleanFormText(raw.get("category") ?? "");
  const category = (CONTACT_CATEGORIES as readonly string[]).includes(categoryRaw)
    ? (categoryRaw as ContactCategory)
    : null;
  if (!category) fieldErrors.category = categoryRaw === "" ? "required" : "invalid";

  const subject = cleanFormText(raw.get("subject") ?? "").replace(/\s+/g, " ");
  const subjectError = formLengthError(
    subject,
    CONTACT_LIMITS.subjectMin,
    CONTACT_LIMITS.subjectMax,
  );
  if (subjectError) fieldErrors.subject = subjectError;

  const message = cleanFormText(raw.get("message") ?? "");
  const messageError = formLengthError(
    message,
    CONTACT_LIMITS.messageMin,
    CONTACT_LIMITS.messageMax,
  );
  if (messageError) fieldErrors.message = messageError;

  if (!category || Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, value: { name, email, category, subject, message } };
}

export type SubmitContactResult =
  | { status: "ok" }
  | {
      status: "invalid";
      fieldErrors: Partial<Record<ContactFormField, ContactFormFieldError>>;
      formError?: "malformed" | "too_large";
    }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/** Postgres hata kodu (orn. `23514`); mesaj ya da deger icermez. */
function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/i.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

export async function submitContact(
  db: Pick<Database, "insert">,
  input: {
    fields: Iterable<[string, unknown]>;
    /** Yalnizca sunucudaki oturumdan; formdaki hicbir alan kimlik tasimaz. */
    userId: number | null;
    ip: string | null;
  },
  increment?: FixedWindowCounter,
): Promise<SubmitContactResult> {
  const validation = validateContact(input.fields);
  if (!validation.ok) {
    return validation.formError
      ? { status: "invalid", fieldErrors: validation.fieldErrors, formError: validation.formError }
      : { status: "invalid", fieldErrors: validation.fieldErrors };
  }

  // Geri bildirimle AYNI kota (10 dk / 5): iki form birlikte bir yazma
  // yolu acip siniri ikiye katlamaz. Redis yoksa yazilmaz (fail-closed).
  try {
    const allowed = await consumeFeedbackQuota({ userId: input.userId, ip: input.ip }, increment);
    if (!allowed) return { status: "rate_limited" };
  } catch (error) {
    if (isRedisUnavailableError(error)) {
      console.error("[contact] rate limit unavailable");
      return { status: "unavailable" };
    }
    throw error;
  }

  const value = validation.value;
  try {
    await db.insert(feedback).values({
      kind: "contact",
      userId: input.userId,
      name: value.name,
      email: value.email,
      category: value.category,
      title: value.subject,
      message: value.message,
      priority: null,
      source: input.userId !== null ? "early_access" : "public",
    });
  } catch (error) {
    console.error(`[contact] insert failed: ${errorCode(error)}`);
    return { status: "unavailable" };
  }
  return { status: "ok" };
}
