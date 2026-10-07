/**
 * `/yonetim/formlar` (docs/decisions/0058). Form olusturma, guncelleme,
 * yayinlama, kapatma ve sonuclar. Her fonksiyon `forms.manage` yetkisini
 * KENDISI denetler (web katmani da ister); her mutasyon denetim kaydini
 * ayni islemde yazar. Denetime soru metni, cevap ve kullanici girmez.
 *
 * Kurallar:
 * - Yanit alinmis formun SORULARI degistirilemez (cevaplar sorulara bagli;
 *   sessizce anlam kaymasi olmasin). Baslik, aciklama, tarih, hedef kitle,
 *   gecilebilirlik ve cok yanit modu her zaman degisir.
 * - Yayinlanmis (bir kez yayinlanmis) formun adresi (slug) degismez:
 *   paylasilan baglanti kirilmasin.
 * - Es zamanli duzenleme `expectedUpdatedAt` ile yakalanir (`conflict`).
 */
import {
  appUser,
  type Database,
  type FormAudience,
  type FormKind,
  type FormQuestionType,
  type FormStatus,
  form,
  formAnswer,
  formQuestion,
  formQuestionOption,
  formResponse,
  formSkip,
} from "@arilla/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { type FormDefinition, FormValidationError, validateFormDefinition } from "./validate.ts";

export { FormValidationError };

export const FORMS_PAGE_SIZE = 25;
const TEXT_ANSWERS_LIMIT = 200;

function requireId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FormValidationError("Geçersiz form.");
  }
  return value;
}

function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/i.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

function constraintOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

/** Benzersizlik ihlallerini yoneticiye anlasilir mesajla dondurur; digerlerini firlatir. */
function translateConflict(error: unknown): never {
  if (errorCode(error) === "23505") {
    const name = constraintOf(error);
    if (name === "form_one_published_onboarding") {
      throw new FormValidationError("Zaten yayında bir onboarding formu var. Önce onu kapat.");
    }
    throw new FormValidationError("Bu adres (slug) zaten kullanılıyor.");
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Liste ve ayrinti
// ---------------------------------------------------------------------------

export interface FormListRow {
  id: number;
  slug: string;
  title: string;
  kind: FormKind;
  status: FormStatus;
  audience: FormAudience;
  responseCount: number;
  createdAt: Date;
}

export async function listForms(
  db: Pick<Database, "select">,
  actor: AdminActor,
  page: number,
): Promise<{ rows: FormListRow[]; hasNext: boolean }> {
  assertCapability(actor, "forms.manage");
  const offset = (Math.max(1, Math.trunc(page)) - 1) * FORMS_PAGE_SIZE;
  const rows = await db
    .select({
      id: form.id,
      slug: form.slug,
      title: form.title,
      kind: form.kind,
      status: form.status,
      audience: form.audience,
      createdAt: form.createdAt,
      responseCount: sql<number>`(SELECT count(*)::int FROM form_response r WHERE r.form_id = ${form.id})`,
    })
    .from(form)
    .orderBy(desc(form.createdAt), desc(form.id))
    .limit(FORMS_PAGE_SIZE + 1)
    .offset(offset);
  return { rows: rows.slice(0, FORMS_PAGE_SIZE), hasNext: rows.length > FORMS_PAGE_SIZE };
}

export interface EditableForm {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  status: FormStatus;
  audience: FormAudience;
  kind: FormKind;
  allowSkip: boolean;
  allowMultipleResponses: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date;
  responseCount: number;
  questions: Array<{
    id: number;
    label: string;
    description: string | null;
    type: FormQuestionType;
    required: boolean;
    options: string[];
  }>;
}

export async function getFormForEdit(
  db: Pick<Database, "select">,
  actor: AdminActor,
  id: unknown,
): Promise<EditableForm | null> {
  assertCapability(actor, "forms.manage");
  const formId = requireId(id);
  const rows = await db.select().from(form).where(eq(form.id, formId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const questions = await db
    .select()
    .from(formQuestion)
    .where(eq(formQuestion.formId, formId))
    .orderBy(asc(formQuestion.sortOrder));
  const options = await db
    .select({
      questionId: formQuestionOption.questionId,
      label: formQuestionOption.label,
      sortOrder: formQuestionOption.sortOrder,
    })
    .from(formQuestionOption)
    .innerJoin(formQuestion, eq(formQuestion.id, formQuestionOption.questionId))
    .where(eq(formQuestion.formId, formId))
    .orderBy(asc(formQuestionOption.sortOrder));
  const counts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(formResponse)
    .where(eq(formResponse.formId, formId));
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    audience: row.audience,
    kind: row.kind,
    allowSkip: row.allowSkip,
    allowMultipleResponses: row.allowMultipleResponses,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    responseCount: counts[0]?.n ?? 0,
    questions: questions.map((q) => ({
      id: q.id,
      label: q.label,
      description: q.description,
      type: q.type,
      required: q.required,
      options: options.filter((o) => o.questionId === q.id).map((o) => o.label),
    })),
  };
}

// ---------------------------------------------------------------------------
// Olusturma / guncelleme
// ---------------------------------------------------------------------------

async function insertQuestions(
  tx: Pick<Database, "insert">,
  formId: number,
  questions: FormDefinition["questions"],
): Promise<void> {
  for (const [index, question] of questions.entries()) {
    const inserted = await tx
      .insert(formQuestion)
      .values({
        formId,
        label: question.label,
        description: question.description,
        type: question.type,
        required: question.required,
        sortOrder: index,
      })
      .returning({ id: formQuestion.id });
    const created = inserted[0];
    if (!created) throw new Error("soru olusturulamadi");
    if (question.options.length > 0) {
      await tx.insert(formQuestionOption).values(
        question.options.map((label, sortOrder) => ({
          questionId: created.id,
          label,
          sortOrder,
        })),
      );
    }
  }
}

function structureOf(questions: FormDefinition["questions"]): string {
  return JSON.stringify(
    questions.map((q) => [q.label, q.description, q.type, q.required, q.options]),
  );
}

export async function createForm(
  db: Database,
  actor: AdminActor,
  input: unknown,
): Promise<{ id: number }> {
  assertCapability(actor, "forms.manage");
  const def = validateFormDefinition(input);
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(form)
        .values({
          slug: def.slug,
          title: def.title,
          description: def.description,
          audience: def.audience,
          kind: def.kind,
          allowSkip: def.allowSkip,
          allowMultipleResponses: def.allowMultipleResponses,
          startsAt: def.startsAt,
          endsAt: def.endsAt,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: form.id });
      const created = inserted[0];
      if (!created) throw new Error("form olusturulamadi");
      await insertQuestions(tx, created.id, def.questions);
      await recordAdminEvent(tx, {
        actor,
        action: "forms.create",
        targetType: "form",
        targetId: created.id,
        after: {
          kind: def.kind,
          audience: def.audience,
          status: "draft",
          questionCount: def.questions.length,
        },
      });
      return { id: created.id };
    });
  } catch (error) {
    return translateConflict(error);
  }
}

export type UpdateFormResult =
  | { status: "updated" }
  | { status: "not_found" }
  | { status: "conflict" };

export async function updateForm(
  db: Database,
  actor: AdminActor,
  id: unknown,
  input: unknown,
  expectedUpdatedAt: unknown,
): Promise<UpdateFormResult> {
  assertCapability(actor, "forms.manage");
  const formId = requireId(id);
  if (typeof expectedUpdatedAt !== "number" || !Number.isFinite(expectedUpdatedAt)) {
    throw new FormValidationError("Geçersiz sürüm. Sayfayı yenile.");
  }
  const def = validateFormDefinition(input);
  try {
    return await db.transaction(async (tx): Promise<UpdateFormResult> => {
      const locked = await tx.select().from(form).where(eq(form.id, formId)).for("update");
      const current = locked[0];
      if (!current) return { status: "not_found" };
      if (current.updatedAt.getTime() !== expectedUpdatedAt) return { status: "conflict" };
      if (current.publishedAt && current.slug !== def.slug) {
        throw new FormValidationError(
          "Yayınlanmış formun adresi değiştirilemez; paylaşılan bağlantı bozulur.",
        );
      }
      const existing = await getFormQuestionsForCompare(tx, formId);
      const questionsChanged = structureOf(existing) !== structureOf(def.questions);
      if (questionsChanged) {
        const responses = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(formResponse)
          .where(eq(formResponse.formId, formId));
        if ((responses[0]?.n ?? 0) > 0) {
          throw new FormValidationError(
            "Yanıt alınmış formun soruları değiştirilemez. Yeni bir form oluştur.",
          );
        }
        await tx.delete(formQuestion).where(eq(formQuestion.formId, formId));
        await insertQuestions(tx, formId, def.questions);
      }
      await tx
        .update(form)
        .set({
          slug: def.slug,
          title: def.title,
          description: def.description,
          audience: def.audience,
          kind: def.kind,
          allowSkip: def.allowSkip,
          allowMultipleResponses: def.allowMultipleResponses,
          startsAt: def.startsAt,
          endsAt: def.endsAt,
          updatedBy: actor.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(form.id, formId));
      await recordAdminEvent(tx, {
        actor,
        action: "forms.update",
        targetType: "form",
        targetId: formId,
        before: { kind: current.kind, audience: current.audience, status: current.status },
        after: {
          kind: def.kind,
          audience: def.audience,
          status: current.status,
          questionCount: def.questions.length,
          questionsChanged,
        },
      });
      return { status: "updated" };
    });
  } catch (error) {
    return translateConflict(error);
  }
}

async function getFormQuestionsForCompare(
  tx: Pick<Database, "select">,
  formId: number,
): Promise<FormDefinition["questions"]> {
  const questions = await tx
    .select()
    .from(formQuestion)
    .where(eq(formQuestion.formId, formId))
    .orderBy(asc(formQuestion.sortOrder));
  const options = await tx
    .select({
      questionId: formQuestionOption.questionId,
      label: formQuestionOption.label,
    })
    .from(formQuestionOption)
    .innerJoin(formQuestion, eq(formQuestion.id, formQuestionOption.questionId))
    .where(eq(formQuestion.formId, formId))
    .orderBy(asc(formQuestionOption.sortOrder));
  return questions.map((q) => ({
    label: q.label,
    description: q.description,
    type: q.type,
    required: q.required,
    options: options.filter((o) => o.questionId === q.id).map((o) => o.label),
  }));
}

// ---------------------------------------------------------------------------
// Yayinla / kapat
// ---------------------------------------------------------------------------

export type SetStatusResult =
  | { status: "changed" }
  | { status: "unchanged" }
  | { status: "not_found" };

export async function setFormStatus(
  db: Database,
  actor: AdminActor,
  id: unknown,
  next: "published" | "closed",
): Promise<SetStatusResult> {
  assertCapability(actor, "forms.manage");
  const formId = requireId(id);
  try {
    return await db.transaction(async (tx): Promise<SetStatusResult> => {
      const locked = await tx.select().from(form).where(eq(form.id, formId)).for("update");
      const current = locked[0];
      if (!current) return { status: "not_found" };
      if (current.status === next) return { status: "unchanged" };
      if (next === "closed" && current.status !== "published") {
        throw new FormValidationError("Yalnızca yayındaki form kapatılabilir.");
      }
      const questions = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(formQuestion)
        .where(eq(formQuestion.formId, formId));
      if (next === "published" && (questions[0]?.n ?? 0) === 0) {
        throw new FormValidationError("Soru olmayan form yayınlanamaz.");
      }
      await tx
        .update(form)
        .set(
          next === "published"
            ? {
                status: next,
                publishedAt: current.publishedAt ?? sql`now()`,
                closedAt: null,
                updatedBy: actor.userId,
                updatedAt: sql`now()`,
              }
            : {
                status: next,
                closedAt: sql`now()`,
                updatedBy: actor.userId,
                updatedAt: sql`now()`,
              },
        )
        .where(eq(form.id, formId));
      await recordAdminEvent(tx, {
        actor,
        action: next === "published" ? "forms.publish" : "forms.close",
        targetType: "form",
        targetId: formId,
        before: { status: current.status },
        after: { status: next, kind: current.kind, audience: current.audience },
      });
      return { status: "changed" };
    });
  } catch (error) {
    return translateConflict(error);
  }
}

// ---------------------------------------------------------------------------
// Sonuclar
// ---------------------------------------------------------------------------

export interface ChoiceResult {
  questionId: number;
  label: string;
  type: "single_choice" | "multiple_choice";
  answered: number;
  options: Array<{ label: string; count: number; percent: number }>;
}

export interface TextResult {
  questionId: number;
  label: string;
  type: "short_text" | "long_text";
  answered: number;
  /** `userRef`: hesabin public kimligi (e-posta degil); anonimde NULL. */
  answers: Array<{ text: string; submittedAt: Date; userRef: string | null }>;
  truncated: boolean;
}

export interface FormResults {
  formId: number;
  title: string;
  slug: string;
  kind: FormKind;
  status: FormStatus;
  totalResponses: number;
  authenticatedResponses: number;
  anonymousResponses: number;
  skipCount: number;
  questions: Array<ChoiceResult | TextResult>;
}

export async function getFormResults(
  db: Database,
  actor: AdminActor,
  id: unknown,
): Promise<FormResults | null> {
  assertCapability(actor, "forms.manage");
  const formId = requireId(id);
  const found = await db.select().from(form).where(eq(form.id, formId)).limit(1);
  const row = found[0];
  if (!row) return null;

  const totals = await db
    .select({
      total: sql<number>`count(*)::int`,
      authenticated: sql<number>`count(*) FILTER (WHERE ${formResponse.userId} IS NOT NULL)::int`,
    })
    .from(formResponse)
    .where(eq(formResponse.formId, formId));
  const skips = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(formSkip)
    .where(eq(formSkip.formId, formId));

  const questions = await db
    .select()
    .from(formQuestion)
    .where(eq(formQuestion.formId, formId))
    .orderBy(asc(formQuestion.sortOrder));

  const results: Array<ChoiceResult | TextResult> = [];
  for (const question of questions) {
    if (question.type === "single_choice" || question.type === "multiple_choice") {
      const counts = await db
        .select({
          label: formQuestionOption.label,
          sortOrder: formQuestionOption.sortOrder,
          count: sql<number>`count(${formAnswer.id})::int`,
        })
        .from(formQuestionOption)
        .leftJoin(formAnswer, eq(formAnswer.optionId, formQuestionOption.id))
        .where(eq(formQuestionOption.questionId, question.id))
        .groupBy(formQuestionOption.id, formQuestionOption.label, formQuestionOption.sortOrder)
        .orderBy(asc(formQuestionOption.sortOrder));
      const answeredRows = await db
        .select({ n: sql<number>`count(DISTINCT ${formAnswer.responseId})::int` })
        .from(formAnswer)
        .where(eq(formAnswer.questionId, question.id));
      const answered = answeredRows[0]?.n ?? 0;
      results.push({
        questionId: question.id,
        label: question.label,
        type: question.type,
        answered,
        options: counts.map((c) => ({
          label: c.label,
          count: c.count,
          percent: answered === 0 ? 0 : Math.round((c.count / answered) * 1000) / 10,
        })),
      });
      continue;
    }
    const texts = await db
      .select({
        text: formAnswer.textValue,
        submittedAt: formResponse.submittedAt,
        userRef: appUser.publicId,
      })
      .from(formAnswer)
      .innerJoin(formResponse, eq(formResponse.id, formAnswer.responseId))
      .leftJoin(appUser, eq(appUser.id, formResponse.userId))
      .where(eq(formAnswer.questionId, question.id))
      .orderBy(desc(formResponse.submittedAt), desc(formAnswer.id))
      .limit(TEXT_ANSWERS_LIMIT + 1);
    results.push({
      questionId: question.id,
      label: question.label,
      type: question.type,
      answered: Math.min(texts.length, TEXT_ANSWERS_LIMIT),
      answers: texts
        .slice(0, TEXT_ANSWERS_LIMIT)
        .map((t) => ({ text: t.text ?? "", submittedAt: t.submittedAt, userRef: t.userRef })),
      truncated: texts.length > TEXT_ANSWERS_LIMIT,
    });
  }

  await recordAdminEvent(db, {
    actor,
    action: "forms.results_view",
    targetType: "form",
    targetId: formId,
    after: { responses: totals[0]?.total ?? 0 },
  });

  const total = totals[0]?.total ?? 0;
  const authenticated = totals[0]?.authenticated ?? 0;
  return {
    formId,
    title: row.title,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    totalResponses: total,
    authenticatedResponses: authenticated,
    anonymousResponses: total - authenticated,
    skipCount: skips[0]?.n ?? 0,
    questions: results,
  };
}
