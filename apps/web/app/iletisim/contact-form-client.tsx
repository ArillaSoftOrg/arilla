"use client";

import type { ContactFormField, ContactFormFieldError } from "@arilla/core";
import { loginPathWithNext } from "@arilla/core/auth-redirect";
import type { ContactCategory } from "@arilla/db";
import { Button, Input } from "@arilla/ui";
import { useActionState, useEffect, useId, useRef } from "react";
// Form dili `/geri-bildirim` ile ayni: ayni CSS modulu, ikinci bir kopya yok.
import styles from "../geri-bildirim/page.module.css";
import { type ContactActionResult, submitContactAction } from "./actions.ts";
import { CONTACT_CATEGORY_LABELS, CONTACT_COPY as COPY } from "./contact-copy.ts";

type Values = Partial<Record<ContactFormField, string>>;

interface FormState {
  result: ContactActionResult | { status: "idle" } | { status: "network_error" };
  /** Hata durumunda alanlar bunlarla yeniden doldurulur (React form eylemi formu sifirlar). */
  values: Values;
}

const CATEGORIES = Object.keys(CONTACT_CATEGORY_LABELS) as ContactCategory[];
const LOGIN_AGAIN_HREF = loginPathWithNext("/iletisim");
const INITIAL: FormState = { result: { status: "idle" }, values: {} };

// Sinirlar core'daki `CONTACT_LIMITS` ile ayni; tarayicida yalnizca erken
// uyari icindir, asil dogrulama sunucudadir.
const NAME_MIN = 2;
const NAME_MAX = 100;
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 120;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

function readValues(formData: FormData): Values {
  const values: Values = {};
  for (const key of ["name", "email", "category", "subject", "message"] as const) {
    const value = formData.get(key);
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

function fieldMessage(
  field: ContactFormField,
  error: ContactFormFieldError | undefined,
): string | undefined {
  if (!error) return undefined;
  switch (field) {
    case "name":
      return error === "required" ? COPY.nameRequired : COPY.nameLength;
    case "email":
      return error === "required" ? COPY.emailRequired : COPY.emailInvalid;
    case "category":
      return COPY.categoryRequired;
    case "subject":
      return error === "required" ? COPY.subjectRequired : COPY.subjectLength;
    case "message":
      return error === "required" ? COPY.messageRequired : COPY.messageLength;
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
 * `/iletisim` formu (docs/decisions/0061). Gonderim server action'a gider;
 * ag hatasi burada yakalanir. Gonderim surerken dugme devre disi.
 *
 * `signedIn` ve `defaultEmail` sayfanin cizildigi andaki oturumdan gelir ve
 * yalnizca arayuzu belirler; hesap baglantisi sunucuda oturumdan kurulur.
 */
export function ContactFormClient({
  signedIn,
  defaultName,
  defaultEmail,
}: {
  signedIn: boolean;
  defaultName: string;
  defaultEmail: string;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const values = readValues(formData);
      try {
        return { result: await submitContactAction(signedIn, formData), values };
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
  const errorFor = (field: ContactFormField) => fieldMessage(field, fieldErrors[field]);
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
          <a className={styles.secondaryAction} href="/iletisim">
            {COPY.successAnother}
          </a>
        </div>
      </div>
    );
  }

  const categoryError = errorFor("category");
  const messageError = errorFor("message");
  const ids = {
    categoryError: `${baseId}-category-error`,
    message: `${baseId}-message`,
    messageHint: `${baseId}-message-hint`,
    messageError: `${baseId}-message-error`,
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

      <Input
        label={COPY.nameLabel}
        name="name"
        type="text"
        required
        minLength={NAME_MIN}
        maxLength={NAME_MAX}
        autoComplete="name"
        defaultValue={values.name ?? defaultName}
        error={errorFor("name")}
      />

      <Input
        label={COPY.emailLabel}
        name="email"
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        maxLength={254}
        hint={COPY.emailHint}
        defaultValue={values.email ?? defaultEmail}
        error={errorFor("email")}
      />

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
              <span className={styles.choiceLabel}>{CONTACT_CATEGORY_LABELS[category]}</span>
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
        label={COPY.subjectLabel}
        name="subject"
        type="text"
        required
        minLength={SUBJECT_MIN}
        maxLength={SUBJECT_MAX}
        autoComplete="off"
        placeholder={COPY.subjectPlaceholder}
        defaultValue={values.subject ?? ""}
        error={errorFor("subject")}
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
        {COPY.privacyNote} <a href="/gizlilik">{COPY.privacyLink}</a> {COPY.privacyAnd}{" "}
        <a href="/kvkk-aydinlatma">{COPY.kvkkLink}</a> {COPY.privacyNoteEnd}
      </p>
    </form>
  );
}
