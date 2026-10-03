"use client";

import { loginPathWithNext } from "@arilla/core/auth-redirect";
import { Button, Input } from "@arilla/ui";
import { useActionState, useEffect, useId, useRef } from "react";
import styles from "../page.module.css";
import { SURVEY_COPY as COPY } from "../survey-copy.ts";
import { type SurveyActionResult, submitSurveyAction } from "./actions.ts";

export interface SurveyQuestion {
  id: number;
  label: string;
  description: string | null;
  type: "single_choice" | "multiple_choice" | "short_text" | "long_text";
  required: boolean;
  options: Array<{ id: number; label: string }>;
}

/** Girilen değerler: soru kimliği → değerler. Hata sonrası alanlar bunlarla doldurulur. */
type Values = Record<string, string[]>;

interface FormState {
  result: SurveyActionResult | { status: "idle" } | { status: "network_error" };
  values: Values;
}

const INITIAL: FormState = { result: { status: "idle" }, values: {} };

function readValues(formData: FormData): Values {
  const values: Values = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("q_") || typeof value !== "string") continue;
    const list = values[key];
    if (list) list.push(value);
    else values[key] = [value];
  }
  return values;
}

function fieldMessage(error: string | undefined): string | undefined {
  switch (error) {
    case "required":
      return COPY.errorRequired;
    case "invalid":
      return COPY.errorInvalid;
    case "too_long":
      return COPY.errorTooLong;
    default:
      return undefined;
  }
}

function formMessage(result: FormState["result"]): string | undefined {
  switch (result.status) {
    case "invalid":
      if (result.formError === "too_large") return COPY.tooLarge;
      if (result.formError === "malformed") return COPY.malformed;
      return COPY.fixErrors;
    case "rate_limited":
      return COPY.rateLimited;
    case "unavailable":
      return COPY.unavailable;
    case "network_error":
      return COPY.network;
    case "session_expired":
      return COPY.sessionExpired;
    default:
      return undefined;
  }
}

/**
 * Anket formu. Gönderim server action'a gider; ağ hatası kullanıcıyı
 * yanıtlarıyla birlikte formda bırakır. Soru tipi ve seçenekler sunucudaki
 * form tanımından gelir; burada yalnızca çizilir. Gönderim sürerken düğme
 * devre dışıdır: çift gönderim olmaz.
 */
export function SurveyFormClient({
  slug,
  signedIn,
  hint,
  questions,
  successHref,
  successLabel,
}: {
  slug: string;
  signedIn: boolean;
  hint: "link" | "account";
  questions: SurveyQuestion[];
  successHref: string;
  successLabel: string;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const values = readValues(formData);
      try {
        return { result: await submitSurveyAction(slug, signedIn, hint, formData), values };
      } catch {
        return { result: { status: "network_error" }, values };
      }
    },
    INITIAL,
  );

  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const baseId = useId();
  const { result, values } = state;
  const fieldErrors = result.status === "invalid" ? result.fieldErrors : {};
  const alertText = formMessage(result);

  useEffect(() => {
    if (result.status === "ok") {
      successRef.current?.focus();
      return;
    }
    if (result.status === "idle") return;
    const firstInvalid = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
    (firstInvalid ?? alertRef.current)?.focus();
  }, [result]);

  if (result.status === "ok") {
    return (
      <div className={styles.success} role="status">
        <span className={styles.successMark} aria-hidden="true" />
        <h2 ref={successRef} tabIndex={-1} className={styles.successTitle}>
          {COPY.successTitle}
        </h2>
        <p className={styles.successBody}>{COPY.successBody}</p>
        <div className={styles.successActions}>
          <a className={styles.primaryAction} href={successHref}>
            {successLabel}
          </a>
        </div>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className={styles.form}
      aria-busy={pending || undefined}
      aria-describedby={alertText ? `${baseId}-alert` : undefined}
    >
      <p className={styles.authNotice}>{signedIn ? COPY.authNotice : COPY.anonymousNotice}</p>

      {questions.map((question) => {
        const name = `q_${question.id}`;
        const error = fieldMessage(fieldErrors[question.id]);
        const errorId = `${baseId}-${question.id}-error`;
        const given = values[name] ?? [];

        if (question.type === "single_choice" || question.type === "multiple_choice") {
          const multiple = question.type === "multiple_choice";
          return (
            <fieldset
              key={question.id}
              className={styles.fieldset}
              aria-describedby={error ? errorId : undefined}
            >
              <legend className={styles.legend}>
                {question.label}
                {question.required ? null : ` ${COPY.optional}`}
              </legend>
              {question.description ? <p className={styles.hint}>{question.description}</p> : null}
              <div className={styles.choices}>
                {question.options.map((option) => (
                  <label key={option.id} className={styles.choice}>
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={name}
                      value={String(option.id)}
                      required={question.required && !multiple}
                      defaultChecked={given.includes(String(option.id))}
                      aria-invalid={error ? true : undefined}
                      className={styles.choiceInput}
                    />
                    <span className={styles.choiceLabel}>{option.label}</span>
                  </label>
                ))}
              </div>
              {error ? (
                <p id={errorId} className={styles.errorText}>
                  {error}
                </p>
              ) : null}
            </fieldset>
          );
        }

        if (question.type === "short_text") {
          return (
            <Input
              key={question.id}
              label={question.required ? question.label : `${question.label} ${COPY.optional}`}
              name={name}
              type="text"
              required={question.required}
              maxLength={500}
              autoComplete="off"
              {...(question.description ? { hint: question.description } : {})}
              defaultValue={given[0] ?? ""}
              {...(error ? { error } : {})}
            />
          );
        }

        const textareaId = `${baseId}-${question.id}`;
        const hintId = `${textareaId}-hint`;
        return (
          <div key={question.id} className={styles.field}>
            <label className={styles.label} htmlFor={textareaId}>
              {question.label}
              {question.required ? null : ` ${COPY.optional}`}
            </label>
            {question.description ? (
              <p id={hintId} className={styles.hint}>
                {question.description}
              </p>
            ) : null}
            <textarea
              id={textareaId}
              name={name}
              required={question.required}
              maxLength={5000}
              rows={5}
              defaultValue={given[0] ?? ""}
              aria-invalid={error ? true : undefined}
              aria-describedby={
                [question.description ? hintId : null, error ? errorId : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              className={styles.textarea}
            />
            {error ? (
              <p id={errorId} className={styles.errorText}>
                {error}
              </p>
            ) : null}
          </div>
        );
      })}

      {alertText ? (
        <p
          id={`${baseId}-alert`}
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className={styles.alert}
        >
          {alertText}
          {result.status === "session_expired" ? (
            <>
              {" "}
              <a href={loginPathWithNext(`/anket/${slug}`)}>{COPY.loginCta}</a>
            </>
          ) : null}
        </p>
      ) : null}

      <Button type="submit" variant="accent" size="lg" shape="pill" disabled={pending}>
        {pending ? COPY.submitting : COPY.submit}
      </Button>

      <p className={styles.privacyNote}>
        {COPY.privacyNote} <a href="/gizlilik">{COPY.privacyLink}</a> {COPY.privacyNoteEnd}
      </p>
    </form>
  );
}
