/**
 * Public form akisi (docs/decisions/0058): `/anket/<slug>` goruntuleme,
 * gonderim, onboarding'de "Simdilik gec" ve Hesabim'daki eksik formlar.
 *
 * Sira (gonderim): form durumu -> hedef kitle -> oturum (cagiran verir) ->
 * dogrulama -> oran siniri -> tek islemde INSERT.
 *
 * - Kimlik yalnizca cagirandaki oturumdan gelir; formdaki hicbir alan
 *   kimlik tasimaz (bilinmeyen alan formu reddeder).
 * - Soru tipi, secenekler ve zorunluluk her zaman sunucudaki form
 *   tanimindan okunur.
 * - Tek yanitli formda cift yanit MOTORDA engellenir (kismi UNIQUE indeks);
 *   yaris durumunda `already_responded` doner.
 * - Hata ayrintisi (SQL, Redis) cagirana ve kayitlara gitmez; logda yalnizca
 *   hata kodu. Cevap metni ve kimlik loglanmaz.
 */
import {
  type Database,
  type FormAudience,
  type FormQuestionType,
  type FormResponseSource,
  form,
  formAnswer,
  formQuestion,
  formQuestionOption,
  formResponse,
  formSkip,
} from "@arilla/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getEarlyAccess } from "../access/early-access.ts";
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { audienceGate, formAvailability } from "./availability.ts";
import { consumeFormQuota } from "./rate-limit.ts";
import { type AnswerFieldError, validateAnswers } from "./validate.ts";

export interface FormViewer {
  id: number;
}

export interface PublicQuestion {
  id: number;
  label: string;
  description: string | null;
  type: FormQuestionType;
  required: boolean;
  options: Array<{ id: number; label: string }>;
}

export interface PublicForm {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  audience: FormAudience;
  kind: "survey" | "onboarding";
  allowSkip: boolean;
  allowMultipleResponses: boolean;
  questions: PublicQuestion[];
}

export type FormGate =
  | { status: "not_found" }
  | { status: "closed"; title: string }
  | { status: "not_started"; title: string; startsAt: Date | null }
  | { status: "login_required"; title: string }
  | { status: "early_access_required"; title: string }
  | { status: "already_responded"; title: string };

type Reader = Pick<Database, "select">;

async function loadForm(db: Reader, slug: string): Promise<PublicFormRow | null> {
  const rows = await db.select().from(form).where(eq(form.slug, slug)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const questions = await db
    .select()
    .from(formQuestion)
    .where(eq(formQuestion.formId, row.id))
    .orderBy(asc(formQuestion.sortOrder));
  const ids = questions.map((q) => q.id);
  const options =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(formQuestionOption)
          .where(inArray(formQuestionOption.questionId, ids))
          .orderBy(asc(formQuestionOption.sortOrder));
  return {
    row,
    questions: questions.map((q) => ({
      id: q.id,
      label: q.label,
      description: q.description,
      type: q.type,
      required: q.required,
      options: options
        .filter((o) => o.questionId === q.id)
        .map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}

interface PublicFormRow {
  row: typeof form.$inferSelect;
  questions: PublicQuestion[];
}

function toPublic({ row, questions }: PublicFormRow): PublicForm {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    audience: row.audience,
    kind: row.kind,
    allowSkip: row.allowSkip,
    allowMultipleResponses: row.allowMultipleResponses,
    questions,
  };
}

async function hasResponded(db: Reader, formId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: formResponse.id })
    .from(formResponse)
    .where(and(eq(formResponse.formId, formId), eq(formResponse.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** Form + izleyici icin kapi. Taslak ziyaretciye hic gorunmez (`not_found`). */
async function resolve(
  db: Reader,
  slug: string,
  user: FormViewer | null,
  now: Date,
): Promise<{ gate: FormGate } | { gate: null; loaded: PublicFormRow }> {
  const loaded = await loadForm(db, slug);
  if (!loaded) return { gate: { status: "not_found" } };
  const { row } = loaded;
  const availability = formAvailability(row, now);
  if (availability === "draft") return { gate: { status: "not_found" } };
  if (availability === "closed" || availability === "ended") {
    return { gate: { status: "closed", title: row.title } };
  }
  if (availability === "not_started") {
    return { gate: { status: "not_started", title: row.title, startsAt: row.startsAt } };
  }
  const member =
    row.audience === "early_access" && user ? (await getEarlyAccess(db, user.id)) !== null : false;
  const gate = audienceGate(row.audience, user, member);
  if (gate === "login_required") return { gate: { status: "login_required", title: row.title } };
  if (gate === "early_access_required") {
    return { gate: { status: "early_access_required", title: row.title } };
  }
  if (user && !row.allowMultipleResponses && (await hasResponded(db, row.id, user.id))) {
    return { gate: { status: "already_responded", title: row.title } };
  }
  return { gate: null, loaded };
}

export type FormViewResult = FormGate | { status: "open"; form: PublicForm; skipped: boolean };

export async function getFormForViewer(
  db: Reader,
  slug: string,
  user: FormViewer | null,
  now: Date = new Date(),
): Promise<FormViewResult> {
  const resolved = await resolve(db, slug, user, now);
  if (resolved.gate) return resolved.gate;
  const skipped = user ? await hasSkipped(db, resolved.loaded.row.id, user.id) : false;
  return { status: "open", form: toPublic(resolved.loaded), skipped };
}

async function hasSkipped(db: Reader, formId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ formId: formSkip.formId })
    .from(formSkip)
    .where(and(eq(formSkip.formId, formId), eq(formSkip.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Gonderim
// ---------------------------------------------------------------------------

export type SubmitFormResult =
  | { status: "ok" }
  | {
      status: "invalid";
      fieldErrors: Record<number, AnswerFieldError>;
      formError?: "malformed" | "too_large";
    }
  | { status: "rate_limited" }
  | { status: "unavailable" }
  | Exclude<FormGate, { status: "closed" } | { status: "not_started" }>
  | { status: "closed" }
  | { status: "not_started" };

/** Postgres hata kodu (orn. `23505`); mesaj ya da deger icermez. */
function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/i.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

export async function submitForm(
  db: Pick<Database, "select" | "transaction">,
  input: {
    slug: string;
    fields: Iterable<[string, unknown]>;
    user: FormViewer | null;
    ip: string | null;
    source: FormResponseSource;
    now?: Date;
  },
  increment?: FixedWindowCounter,
): Promise<SubmitFormResult> {
  const resolved = await resolve(db, input.slug, input.user, input.now ?? new Date());
  if (resolved.gate) {
    const gate = resolved.gate;
    if (gate.status === "closed" || gate.status === "not_started") return { status: gate.status };
    return gate;
  }
  const { row, questions } = resolved.loaded;

  const validation = validateAnswers(questions, input.fields);
  if (!validation.ok) {
    return validation.formError
      ? { status: "invalid", fieldErrors: validation.fieldErrors, formError: validation.formError }
      : { status: "invalid", fieldErrors: validation.fieldErrors };
  }

  try {
    const allowed = await consumeFormQuota(
      {
        formId: row.id,
        userId: input.user?.id ?? null,
        ip: input.ip,
        singleResponse: !row.allowMultipleResponses,
      },
      increment,
    );
    if (!allowed) return { status: "rate_limited" };
  } catch (error) {
    if (isRedisUnavailableError(error)) {
      console.error("[forms] rate limit unavailable");
      return { status: "unavailable" };
    }
    throw error;
  }

  try {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(formResponse)
        .values({
          formId: row.id,
          userId: input.user?.id ?? null,
          singleResponse: !row.allowMultipleResponses,
          source: input.source,
        })
        .returning({ id: formResponse.id });
      const response = inserted[0];
      if (!response) throw new Error("yanit olusturulamadi");
      if (validation.answers.length > 0) {
        await tx.insert(formAnswer).values(
          validation.answers.map((answer) => ({
            responseId: response.id,
            questionId: answer.questionId,
            optionId: answer.optionId,
            textValue: answer.textValue,
          })),
        );
      }
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "23505" && input.user) {
      return { status: "already_responded", title: row.title };
    }
    console.error(`[forms] insert failed: ${code}`);
    return { status: "unavailable" };
  }
  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// "Simdilik gec", onboarding, Hesabim
// ---------------------------------------------------------------------------

export type SkipFormResult =
  | { status: "ok" }
  | { status: "not_allowed" }
  | Extract<FormGate, { status: "not_found" | "login_required" | "early_access_required" }>
  | { status: "closed" }
  | { status: "already_responded" };

/**
 * Formu atlar. Tamamlandi SAYILMAZ: yalnizca bir hatirlatma kaydi yazar;
 * erken erisim kaydina dokunmaz, kullaniciyi engellemez. Form daha sonra
 * Hesabim'dan doldurulabilir.
 */
export async function skipForm(
  db: Pick<Database, "select" | "insert">,
  input: { slug: string; user: FormViewer | null; now?: Date },
): Promise<SkipFormResult> {
  const resolved = await resolve(db, input.slug, input.user, input.now ?? new Date());
  if (resolved.gate) {
    const gate = resolved.gate;
    if (gate.status === "closed" || gate.status === "not_started") return { status: "closed" };
    if (gate.status === "already_responded") return { status: "already_responded" };
    return gate;
  }
  const { row } = resolved.loaded;
  if (!input.user) return { status: "login_required", title: row.title };
  if (!row.allowSkip) return { status: "not_allowed" };
  await db
    .insert(formSkip)
    .values({ formId: row.id, userId: input.user.id })
    .onConflictDoNothing({ target: [formSkip.formId, formSkip.userId] });
  return { status: "ok" };
}

export interface PendingForm {
  slug: string;
  title: string;
  kind: "survey" | "onboarding";
  skipped: boolean;
}

/**
 * Kullanicinin hedef kitlesine uygun, yayinda ve acik, henuz yanitlamadigi
 * TEK YANITLI formlar (Hesabim "Tamamlanmamis formlar"). `public` hedefli
 * formlar paylasim baglantisidir, burada listelenmez. Onboarding en uste.
 */
export async function listIncompleteForms(
  db: Reader,
  userId: number,
  now: Date = new Date(),
): Promise<PendingForm[]> {
  const member = (await getEarlyAccess(db, userId)) !== null;
  const audiences: FormAudience[] = member ? ["authenticated", "early_access"] : ["authenticated"];
  const rows = await db
    .select({
      slug: form.slug,
      title: form.title,
      kind: form.kind,
      skipped: sql<boolean>`EXISTS (SELECT 1 FROM form_skip s WHERE s.form_id = ${form.id} AND s.user_id = ${userId})`,
    })
    .from(form)
    .where(
      and(
        eq(form.status, "published"),
        eq(form.allowMultipleResponses, false),
        inArray(form.audience, audiences),
        sql`(${form.startsAt} IS NULL OR ${form.startsAt} <= ${now})`,
        sql`(${form.endsAt} IS NULL OR ${form.endsAt} > ${now})`,
        sql`NOT EXISTS (SELECT 1 FROM form_response r WHERE r.form_id = ${form.id} AND r.user_id = ${userId})`,
      ),
    )
    .orderBy(sql`(${form.kind} = 'onboarding') DESC`, asc(form.id));
  return rows;
}

/**
 * Erken erisim uyesi icin bekleyen onboarding formu: yayinda, acik, yanit
 * yok VE atlama kaydi yok. Bulunursa `/erken-erisim` ilk katilimda yonlendirir.
 */
export async function getPendingOnboarding(
  db: Reader,
  userId: number,
  now: Date = new Date(),
): Promise<{ slug: string; title: string } | null> {
  const pending = await listIncompleteForms(db, userId, now);
  const found = pending.find((f) => f.kind === "onboarding" && !f.skipped);
  return found ? { slug: found.slug, title: found.title } : null;
}

/** Hesabim bolumu ve ilk-katilim karti: atlanmis olsa da doldurulabilir onboarding. */
export async function getOnboardingOffer(
  db: Reader,
  userId: number,
  now: Date = new Date(),
): Promise<PendingForm | null> {
  const pending = await listIncompleteForms(db, userId, now);
  return pending.find((f) => f.kind === "onboarding") ?? null;
}

/**
 * Paylasim onizlemesi (title/description) icin: yalnizca yayinda ve acik
 * formun baslik/aciklamasi. Taslak/kapali/zamani gelmemis form `null`;
 * soru ve yanit icermez.
 */
export async function getFormMeta(
  db: Reader,
  slug: string,
  now: Date = new Date(),
): Promise<{ title: string; description: string | null } | null> {
  const rows = await db.select().from(form).where(eq(form.slug, slug)).limit(1);
  const row = rows[0];
  if (!row || formAvailability(row, now) !== "open") return null;
  return { title: row.title, description: row.description };
}
