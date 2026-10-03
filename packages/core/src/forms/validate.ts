/**
 * Form / anket dogrulamasi (docs/decisions/0058). Saf fonksiyonlar: Redis'e
 * ve veritabanina dokunmaz, birim testlidir.
 *
 * - `validateFormDefinition`: yoneticinin gonderdigi form tanimi. Hata
 *   mesaji yoneticiye doner (Turkce), bu yuzden `FormValidationError`.
 * - `validateAnswers`: ziyaretcinin cevaplari. Girdi guvenilmezdir; soru
 *   tipi, secenekler ve zorunluluk HER ZAMAN sunucudaki form tanimindan
 *   gelir, istemcinin soyledigine guvenilmez.
 */
import {
  FORM_AUDIENCES,
  FORM_KINDS,
  FORM_QUESTION_TYPES,
  type FormAudience,
  type FormKind,
  type FormQuestionType,
} from "@arilla/db";

export const FORM_LIMITS = {
  slugMin: 3,
  slugMax: 80,
  titleMax: 200,
  descriptionMax: 2000,
  questionsMax: 30,
  questionLabelMax: 300,
  questionDescriptionMax: 1000,
  optionsMin: 2,
  optionsMax: 20,
  optionLabelMax: 200,
  shortTextMax: 500,
  longTextMax: 5000,
  /** Bir gonderimdeki alan sayisi tavani (30 soru x 20 secenek icin cok altinda). */
  entriesMax: 200,
  /** Tum cevap metinlerinin toplam uzunlugu. */
  payloadMax: 60_000,
} as const;

export class FormValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormValidationError";
  }
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: kontrol karakterlerini atmak icin.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").trim();
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

export interface QuestionDefinition {
  label: string;
  description: string | null;
  type: FormQuestionType;
  required: boolean;
  options: string[];
}

export interface FormDefinition {
  slug: string;
  title: string;
  description: string | null;
  audience: FormAudience;
  kind: FormKind;
  allowSkip: boolean;
  allowMultipleResponses: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  questions: QuestionDefinition[];
}

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new FormValidationError(`${field} gerekli.`);
    return null;
  }
  if (typeof value !== "string") throw new FormValidationError(`${field} geçersiz.`);
  const cleaned = clean(value);
  if (cleaned === "") {
    if (required) throw new FormValidationError(`${field} gerekli.`);
    return null;
  }
  if (codePoints(cleaned) > max) {
    throw new FormValidationError(`${field} en fazla ${max} karakter olabilir.`);
  }
  return cleaned;
}

function bool(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new FormValidationError(`${field} geçersiz.`);
  return value;
}

/** `datetime-local` degeri (`YYYY-MM-DDTHH:mm`) Turkiye saati (UTC+3, DST yok) olarak okunur. */
export function parseLocalDateTime(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !LOCAL_DATETIME.test(value)) {
    throw new FormValidationError(`${field} geçersiz.`);
  }
  const date = new Date(`${value}:00+03:00`);
  if (Number.isNaN(date.getTime())) throw new FormValidationError(`${field} geçersiz.`);
  return date;
}

function validateQuestion(raw: unknown, index: number): QuestionDefinition {
  const where = `Soru ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FormValidationError(`${where} geçersiz.`);
  }
  const q = raw as Record<string, unknown>;
  const label = text(q.label, `${where} metni`, FORM_LIMITS.questionLabelMax, true) as string;
  const description = text(
    q.description,
    `${where} açıklaması`,
    FORM_LIMITS.questionDescriptionMax,
    false,
  );
  if (typeof q.type !== "string" || !(FORM_QUESTION_TYPES as readonly string[]).includes(q.type)) {
    throw new FormValidationError(`${where} türü geçersiz.`);
  }
  const type = q.type as FormQuestionType;
  const required = bool(q.required, `${where} zorunluluğu`);

  const isChoice = type === "single_choice" || type === "multiple_choice";
  const rawOptions = q.options === undefined ? [] : q.options;
  if (!Array.isArray(rawOptions)) throw new FormValidationError(`${where} seçenekleri geçersiz.`);
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of rawOptions) {
    const label_ = text(item, `${where} seçeneği`, FORM_LIMITS.optionLabelMax, false);
    if (label_ === null) continue; // bos satirlar atilir
    const key = label_.toLocaleLowerCase("tr-TR");
    if (seen.has(key)) throw new FormValidationError(`${where}: aynı seçenek iki kez yazılmış.`);
    seen.add(key);
    options.push(label_);
  }
  if (isChoice) {
    if (options.length < FORM_LIMITS.optionsMin || options.length > FORM_LIMITS.optionsMax) {
      throw new FormValidationError(
        `${where}: ${FORM_LIMITS.optionsMin} ile ${FORM_LIMITS.optionsMax} arasında seçenek olmalı.`,
      );
    }
  } else if (options.length > 0) {
    throw new FormValidationError(`${where}: metin sorusunda seçenek olamaz.`);
  }
  return { label, description, type, required, options };
}

export function validateFormDefinition(input: unknown): FormDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FormValidationError("Form geçersiz.");
  }
  const f = input as Record<string, unknown>;

  const slug = text(f.slug, "Adres (slug)", FORM_LIMITS.slugMax, true) as string;
  if (slug.length < FORM_LIMITS.slugMin || !SLUG_PATTERN.test(slug)) {
    throw new FormValidationError(
      "Adres yalnızca küçük harf, rakam ve tire içerebilir (en az 3 karakter).",
    );
  }
  const title = text(f.title, "Başlık", FORM_LIMITS.titleMax, true) as string;
  const description = text(f.description, "Açıklama", FORM_LIMITS.descriptionMax, false);

  if (
    typeof f.audience !== "string" ||
    !(FORM_AUDIENCES as readonly string[]).includes(f.audience)
  ) {
    throw new FormValidationError("Hedef kitle geçersiz.");
  }
  if (typeof f.kind !== "string" || !(FORM_KINDS as readonly string[]).includes(f.kind)) {
    throw new FormValidationError("Form türü geçersiz.");
  }
  const audience = f.audience as FormAudience;
  const kind = f.kind as FormKind;
  if (kind === "onboarding" && audience === "public") {
    throw new FormValidationError("Onboarding formu herkese açık olamaz; giriş gerekir.");
  }

  const startsAt = parseLocalDateTime(f.startsAt, "Başlangıç");
  const endsAt = parseLocalDateTime(f.endsAt, "Bitiş");
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new FormValidationError("Bitiş, başlangıçtan sonra olmalı.");
  }

  if (!Array.isArray(f.questions) || f.questions.length === 0) {
    throw new FormValidationError("En az bir soru ekle.");
  }
  if (f.questions.length > FORM_LIMITS.questionsMax) {
    throw new FormValidationError(`En fazla ${FORM_LIMITS.questionsMax} soru eklenebilir.`);
  }
  const questions = f.questions.map((q, i) => validateQuestion(q, i));

  return {
    slug,
    title,
    description,
    audience,
    kind,
    allowSkip: bool(f.allowSkip, "Geçilebilir"),
    allowMultipleResponses: bool(f.allowMultipleResponses, "Çoklu yanıt"),
    startsAt,
    endsAt,
    questions,
  };
}

// ---------------------------------------------------------------------------
// Cevaplar
// ---------------------------------------------------------------------------

export interface AnswerableQuestion {
  id: number;
  type: FormQuestionType;
  required: boolean;
  options: ReadonlyArray<{ id: number }>;
}

export interface ValidAnswer {
  questionId: number;
  optionId: number | null;
  textValue: string | null;
}

export type AnswerFieldError = "required" | "invalid" | "too_long";

export type AnswersValidation =
  | { ok: true; answers: ValidAnswer[] }
  | {
      ok: false;
      /** Anahtar: soru kimligi. */
      fieldErrors: Record<number, AnswerFieldError>;
      formError?: "malformed" | "too_large";
    };

const FIELD_KEY = /^q_(\d{1,15})$/;

export function validateAnswers(
  questions: readonly AnswerableQuestion[],
  entries: Iterable<[string, unknown]>,
): AnswersValidation {
  const byQuestion = new Map<number, string[]>();
  let count = 0;
  let total = 0;
  for (const [key, value] of entries) {
    if (key.startsWith("$ACTION")) continue;
    const match = FIELD_KEY.exec(key);
    if (!match || typeof value !== "string") {
      return { ok: false, fieldErrors: {}, formError: "malformed" };
    }
    count += 1;
    total += value.length;
    if (count > FORM_LIMITS.entriesMax || total > FORM_LIMITS.payloadMax) {
      return { ok: false, fieldErrors: {}, formError: "too_large" };
    }
    const id = Number(match[1]);
    const list = byQuestion.get(id);
    if (list) list.push(value);
    else byQuestion.set(id, [value]);
  }

  const known = new Set(questions.map((q) => q.id));
  for (const id of byQuestion.keys()) {
    if (!known.has(id)) return { ok: false, fieldErrors: {}, formError: "malformed" };
  }

  const fieldErrors: Record<number, AnswerFieldError> = {};
  const answers: ValidAnswer[] = [];

  for (const question of questions) {
    const values = byQuestion.get(question.id) ?? [];
    if (question.type === "single_choice" || question.type === "multiple_choice") {
      const allowed = new Set(question.options.map((o) => o.id));
      const chosen: number[] = [];
      for (const raw of values) {
        const cleaned = clean(raw);
        if (cleaned === "") continue;
        const id = /^\d{1,15}$/.test(cleaned) ? Number(cleaned) : Number.NaN;
        if (!allowed.has(id)) {
          fieldErrors[question.id] = "invalid";
          break;
        }
        if (!chosen.includes(id)) chosen.push(id);
      }
      if (fieldErrors[question.id]) continue;
      if (question.type === "single_choice" && chosen.length > 1) {
        fieldErrors[question.id] = "invalid";
      } else if (chosen.length === 0) {
        if (question.required) fieldErrors[question.id] = "required";
      } else {
        for (const optionId of chosen) {
          answers.push({ questionId: question.id, optionId, textValue: null });
        }
      }
      continue;
    }

    // short_text / long_text
    if (values.length > 1) {
      fieldErrors[question.id] = "invalid";
      continue;
    }
    let value = clean(values[0] ?? "");
    if (question.type === "short_text") value = value.replace(/\s+/g, " ");
    if (value === "") {
      if (question.required) fieldErrors[question.id] = "required";
      continue;
    }
    const max = question.type === "short_text" ? FORM_LIMITS.shortTextMax : FORM_LIMITS.longTextMax;
    if (codePoints(value) > max) {
      fieldErrors[question.id] = "too_long";
      continue;
    }
    answers.push({ questionId: question.id, optionId: null, textValue: value });
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, answers };
}
