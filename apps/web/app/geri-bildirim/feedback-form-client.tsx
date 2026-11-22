"use client";

import type { FeedbackField, FeedbackFieldError } from "@arilla/core";
import { loginPathWithNext } from "@arilla/core/auth-redirect";
import type { FeedbackCategory } from "@arilla/db";
import { Button, Input } from "@arilla/ui";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { type FeedbackActionResult, submitFeedbackAction } from "./actions.ts";
import { FEEDBACK_COPY as COPY, FEEDBACK_CATEGORY_LABELS } from "./feedback-copy.ts";
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
  for (const key of ["category", "title", "message", "email"] as const) {
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
  const [complete, setComplete] = useState(false);
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

  // Zorunlu alanlar (tur, baslik, aciklama) dolmadan gonderim kapali.
  // Form eylemi sonrasi sifirlandigi icin sonuc degisince de yeniden hesaplanir.
  const recomputeComplete = () => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    setComplete(
      text("category") !== "" &&
        text("title").length >= TITLE_MIN &&
        text("message").length >= MESSAGE_MIN,
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: sonuc degisince yeniden hesapla
  useEffect(() => {
    // Form sifirlamasi bir sonraki karede yansir.
    const id = requestAnimationFrame(recomputeComplete);
    return () => cancelAnimationFrame(id);
  }, [state]);

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
  const ids = {
    category: `${baseId}-category`,
    categoryError: `${baseId}-category-error`,
    message: `${baseId}-message`,
    messageError: `${baseId}-message-error`,
  };

  return (
    <form
      ref={formRef}
      action={action}
      onInput={recomputeComplete}
      onChange={recomputeComplete}
      className={styles.form}
      aria-busy={pending || undefined}
      aria-describedby={alertText ? `${baseId}-alert` : undefined}
    >
      {signedIn ? <p className={styles.authNotice}>{COPY.authNotice}</p> : null}

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.category}>
          {COPY.categoryLegend}
        </label>
        <select
          id={ids.category}
          name="category"
          required
          defaultValue={values.category ?? ""}
          className={styles.select}
          aria-invalid={categoryError ? true : undefined}
          aria-describedby={categoryError ? ids.categoryError : undefined}
        >
          <option value="" disabled>
            {COPY.categoryPlaceholder}
          </option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {FEEDBACK_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
        {categoryError ? (
          <p id={ids.categoryError} className={styles.errorText}>
            {categoryError}
          </p>
        ) : null}
      </div>

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
          rows={3}
          defaultValue={values.message ?? ""}
          className={styles.textarea}
          aria-invalid={messageError ? true : undefined}
          aria-describedby={messageError ? ids.messageError : undefined}
        />
        {messageError ? (
          <span id={ids.messageError} className={styles.errorText}>
            {messageError}
          </span>
        ) : null}
      </div>

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

      <Button type="submit" variant="accent" size="lg" shape="pill" disabled={pending || !complete}>
        {pending ? COPY.submitting : COPY.submit}
      </Button>

      <p className={styles.privacyNote}>
        {COPY.privacyNote} <a href="/gizlilik">{COPY.privacyLink}</a> {COPY.privacyNoteEnd}
      </p>
    </form>
  );
}
