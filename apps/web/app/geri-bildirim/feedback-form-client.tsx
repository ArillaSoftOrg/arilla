"use client";

import type { FeedbackField, FeedbackFieldError } from "@arilla/core";
import { loginPathWithNext } from "@arilla/core/auth-redirect";
import type { FeedbackCategory, FeedbackPriority } from "@arilla/db";
import { Button, Input } from "@arilla/ui";
import { useActionState, useEffect, useId, useRef } from "react";
import { type FeedbackActionResult, submitFeedbackAction } from "./actions.ts";
import {
  FEEDBACK_COPY as COPY,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_PRIORITY_LABELS,
} from "./feedback-copy.ts";
import styles from "./page.module.css";

type Values = Partial<Record<FeedbackField, string>>;

interface FormState {
  result: FeedbackActionResult | { status: "idle" } | { status: "network_error" };
  /** Kullanicinin girdigi degerler: React form eylemi sonrasi formu sifirlar,
   *  hata durumunda alanlar bunlarla yeniden doldurulur. */
  values: Values;
}

// Secenekler etiket kayitlarindan: `Record` tipi her kategorinin etiketi
// oldugunu zorlar; istemci paketine `@arilla/db` degeri cekilmez.
const CATEGORIES = Object.keys(FEEDBACK_CATEGORY_LABELS) as FeedbackCategory[];
const PRIORITIES = Object.keys(FEEDBACK_PRIORITY_LABELS) as FeedbackPriority[];
const LOGIN_AGAIN_HREF = loginPathWithNext("/geri-bildirim");

const INITIAL: FormState = { result: { status: "idle" }, values: {} };

// Alan sinirlari core'daki `FEEDBACK_LIMITS` ile ayni; tarayici tarafinda
// yalnizca erken uyari icindir, asil dogrulama sunucudadir.
const TITLE_MIN = 3;
const TITLE_MAX = 120;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

function readValues(formData: FormData): Values {
  const values: Values = {};
  for (const key of ["category", "title", "message", "priority", "email"] as const) {
    const value = formData.get(key);
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

function fieldMessage(
  field: FeedbackField,
  error: FeedbackFieldError | undefined,
): string | undefined {
  if (!error) return undefined;
  switch (field) {
    case "category":
      return COPY.categoryRequired;
    case "title":
      return error === "required" ? COPY.titleRequired : COPY.titleLength;
    case "message":
      return error === "required" ? COPY.messageRequired : COPY.messageLength;
    case "priority":
      return COPY.priorityInvalid;
    case "email":
      return COPY.emailInvalid;
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
 * `/geri-bildirim` formu. Gonderim server action'a gider; ag hatasi
 * (sunucuya hic ulasilamadi) burada yakalanir ve sayfa hata ekranina
 * dusmez. Gonderim surerken dugme devre disi: cift gonderim olmaz.
 *
 * `signedIn`: sayfanin cizildigi andaki oturum. Yalnizca arayuzu belirler
 * (e-posta alani, hesap notu); kimlik sunucuda oturumdan okunur.
 */
export function FeedbackFormClient({ signedIn }: { signedIn: boolean }) {
  const [state, action, pending] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const values = readValues(formData);
      try {
        return { result: await submitFeedbackAction(signedIn, formData), values };
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
  const errorFor = (field: FeedbackField) => fieldMessage(field, fieldErrors[field]);
  const alertText = formMessage(result);

  // Sonuc degisince odak: basarida baslik, alan hatasinda ilk hatali alan,
  // diger hatalarda uyari metni (ekran okuyucu ve klavye kullanicisi icin).
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
          <a className={styles.primaryAction} href="/">
            {COPY.backHome}
          </a>
          <a className={styles.secondaryAction} href="/geri-bildirim">
            {COPY.successAnother}
          </a>
        </div>
      </div>
    );
  }

  const categoryError = errorFor("category");
  const messageError = errorFor("message");
  const priorityError = errorFor("priority");
  const ids = {
    categoryError: `${baseId}-category-error`,
    message: `${baseId}-message`,
    messageHint: `${baseId}-message-hint`,
    messageError: `${baseId}-message-error`,
    priorityError: `${baseId}-priority-error`,
  };

  return (
    <form
      ref={formRef}
      action={action}
      className={styles.form}
      aria-busy={pending || undefined}
      aria-describedby={alertText ? `${baseId}-alert` : undefined}
    >
      {signedIn ? <p className={styles.authNotice}>{COPY.authNotice}</p> : null}

      <fieldset
        className={styles.fieldset}
        aria-describedby={categoryError ? ids.categoryError : undefined}
      >
        <legend className={styles.legend}>{COPY.categoryLegend}</legend>
        <div className={styles.choices}>
          {CATEGORIES.map((category) => (
            <label key={category} className={styles.choice}>
              <input
                type="radio"
                name="category"
                value={category}
                required
                defaultChecked={values.category === category}
                aria-invalid={categoryError ? true : undefined}
                className={styles.choiceInput}
              />
              <span className={styles.choiceLabel}>{FEEDBACK_CATEGORY_LABELS[category]}</span>
            </label>
          ))}
        </div>
        {categoryError ? (
          <p id={ids.categoryError} className={styles.errorText}>
            {categoryError}
          </p>
        ) : null}
      </fieldset>

      <Input
        label={COPY.titleLabel}
        name="title"
        type="text"
        required
        minLength={TITLE_MIN}
        maxLength={TITLE_MAX}
        autoComplete="off"
        placeholder={COPY.titlePlaceholder}
        defaultValue={values.title ?? ""}
        error={errorFor("title")}
      />

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.message}>
          {COPY.messageLabel}
        </label>
        <textarea
          id={ids.message}
          name="message"
          required
          minLength={MESSAGE_MIN}
          maxLength={MESSAGE_MAX}
          rows={6}
          defaultValue={values.message ?? ""}
          className={styles.textarea}
          aria-invalid={messageError ? true : undefined}
          aria-describedby={[ids.messageHint, messageError ? ids.messageError : null]
            .filter(Boolean)
            .join(" ")}
        />
        <span id={ids.messageHint} className={styles.hint}>
          {COPY.messageHint}
        </span>
        {messageError ? (
          <span id={ids.messageError} className={styles.errorText}>
            {messageError}
          </span>
        ) : null}
      </div>

      <fieldset
        className={styles.fieldset}
        aria-describedby={priorityError ? ids.priorityError : undefined}
      >
        <legend className={styles.legend}>
          {COPY.priorityLegend} <span className={styles.optional}>{COPY.optional}</span>
        </legend>
        <div className={styles.choices}>
          {PRIORITIES.map((priority) => (
            <label key={priority} className={styles.choice}>
              <input
                type="radio"
                name="priority"
                value={priority}
                defaultChecked={values.priority === priority}
                aria-invalid={priorityError ? true : undefined}
                className={styles.choiceInput}
              />
              <span className={styles.choiceLabel}>{FEEDBACK_PRIORITY_LABELS[priority]}</span>
            </label>
          ))}
        </div>
        {priorityError ? (
          <p id={ids.priorityError} className={styles.errorText}>
            {priorityError}
          </p>
        ) : null}
      </fieldset>

      {signedIn ? null : (
        <Input
          label={`${COPY.emailLabel} ${COPY.optional}`}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          hint={COPY.emailHint}
          defaultValue={values.email ?? ""}
          error={errorFor("email")}
        />
      )}

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
              <a href={LOGIN_AGAIN_HREF}>{COPY.loginAgain}</a>
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
