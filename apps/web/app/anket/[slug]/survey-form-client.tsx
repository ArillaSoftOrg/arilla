"use client";

import { loginPathWithNext } from "@arilla/core/auth-redirect";
import { Button, Input } from "@arilla/ui";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import styles from "../page.module.css";
import { SURVEY_COPY as COPY } from "../survey-copy.ts";
import { type SurveyActionResult, submitSurveyAction } from "./actions.ts";
import {
  type Answers,
  fieldName,
  firstErrorStep,
  isChoice,
  isLastStep,
  missingRequired,
  NEWSLETTER_OPT_IN_FIELD,
  NEWSLETTER_STEP_FIELD,
  progressPercent,
  sameValues,
  shouldAutoAdvance,
  showSkipAction,
  toggleValue,
} from "./survey-wizard.ts";

export interface SurveyQuestion {
  id: number;
  label: string;
  description: string | null;
  type: "single_choice" | "multiple_choice" | "short_text" | "long_text";
  required: boolean;
  options: Array<{ id: number; label: string }>;
}

/** Gönderilen değerler: soru alan adı → değerler. Sunucu hatasının bayatlığı bununla ölçülür. */
type Values = Record<string, string[]>;

interface FormState {
  result: SurveyActionResult | { status: "idle" } | { status: "network_error" };
  values: Values;
}

const INITIAL: FormState = { result: { status: "idle" }, values: {} };

/**
 * Seçimden sonraki adıma geçmeden önceki kısa bekleme: seçilen cevap görünsün.
 * Yalnızca ilk görsel geri bildirim içindir; tek ilerleme garantisi kilittir.
 */
const AUTO_ADVANCE_MS = 220;
/** Bir tıklama/Boşluk "bilinçli seçim" sayılacak pencere (ok tuşundan ayırmak için). */
const INTENT_WINDOW_MS = 800;

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
 * Anket formu, adım adım: aynı anda tek soru. Gönderim DEĞİŞMEDİ: tek `<form>`,
 * aynı server action, aynı alan adları (`q_<id>`). Cevaplar durumda tutulur;
 * görünmeyen sorular gizli alan olarak forma yazılır, böylece `FormData` eski
 * (tüm sorular tek sayfada) davranışla birebir aynıdır ve sunucu doğrulaması
 * aynen çalışır. Buradaki "zorunlu" denetimi yalnızca erken uyarıdır.
 *
 * - Tek seçimli soruda tıklama/Boşluk cevabı kaydeder ve kısa bir beklemeden
 *   sonra sonraki soruya geçer. Ok tuşuyla seçim geçmez (klavyeyle gezinen
 *   sayfadan kaçmasın). Son adımda geçiş yoktur, "Tamamla" açık eylemdir.
 * - Metin ve çoktan seçmeli sorular "İleri" ile geçer.
 * - Geri dönüşte cevaplar korunur; cevap değişince durum güncellenir.
 * - Çift ilerleme: bekleyen geçiş varken ikinci geçiş planlanmaz (kilit);
 *   Geri/İleri bekleyen geçişi iptal eder.
 */
export function SurveyFormClient({
  slug,
  signedIn,
  hint,
  questions,
  successHref,
  successLabel,
  skipAction,
  newsletter = null,
}: {
  slug: string;
  signedIn: boolean;
  hint: "link" | "account";
  questions: SurveyQuestion[];
  successHref: string;
  successLabel: string;
  /** Sunucuda kurulan "Şimdilik geç" formu; formun dışında, yalnızca tamamlanmadan çizilir. */
  skipAction?: ReactNode;
  /**
   * Onboarding'in SON adımı (karar 0060): haftalık özet. Soru adımlarından
   * sonra eklenir; varsayılan KAPALI, yalnızca kullanıcı açarsa `true` gider.
   */
  newsletter?: { email: string | null } | null;
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

  const total = questions.length + (newsletter ? 1 : 0);
  const [newsletterOn, setNewsletterOn] = useState(false);
  const [step, setStep] = useState(0);
  const newsletterStep = newsletter !== null && step === questions.length;
  const [direction, setDirection] = useState<"none" | "forward" | "back">("none");
  const [answers, setAnswers] = useState<Answers>({});
  /** "İleri"de zorunlu soru boşsa o sorunun kimliği (satır içi uyarı). */
  const [blockedId, setBlockedId] = useState<number | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerAt = useRef(0);
  const keyAt = useRef(0);
  const stepRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const baseId = useId();
  const { result, values } = state;
  const fieldErrors = result.status === "invalid" ? result.fieldErrors : {};
  const alertText = formMessage(result);
  const skip = showSkipAction(result.status) ? skipAction : null;

  const clearPending = useCallback(() => {
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }, []);

  const goTo = useCallback(
    (target: number) => {
      clearPending();
      setDirection(target > step ? "forward" : "back");
      setStep(Math.min(Math.max(0, target), total - 1));
      setBlockedId(null);
      setFocusToken((token) => token + 1);
    },
    [clearPending, step, total],
  );

  // Bekleyen otomatik geçiş sayfadan çıkılınca ya da bileşen kalkınca iptal edilir.
  useEffect(() => clearPending, [clearPending]);

  // Sunucu sonucu: başarıda odak başlığa; hatada ilk hatalı soruya dön.
  const handledResult = useRef<FormState["result"] | null>(null);
  useEffect(() => {
    if (handledResult.current === result) return;
    handledResult.current = result;
    if (result.status === "ok") {
      successRef.current?.focus();
      return;
    }
    if (result.status === "idle") return;
    if (result.status === "invalid") {
      const errorStep = firstErrorStep(questions, result.fieldErrors);
      if (errorStep !== null) {
        setDirection("back");
        setStep(errorStep);
        setBlockedId(null);
        setFocusToken((token) => token + 1);
        return;
      }
    }
    alertRef.current?.focus();
  }, [result, questions]);

  // Adım değişince (ya da hata sonrası) odak yeni sorunun kabına: ekran okuyucu
  // soruyu okur, Tab ilk seçeneğe gider.
  useEffect(() => {
    if (focusToken === 0) return;
    stepRef.current?.focus();
  }, [focusToken]);

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

  const current = questions[step];
  const last = isLastStep(step, total);
  const showProgress = total > 1;

  function setAnswer(name: string, next: string[]) {
    setAnswers((prev) => ({ ...prev, [name]: next }));
    setBlockedId(null);
  }

  function goNext(event?: MouseEvent<HTMLButtonElement>) {
    // Ek güvence: İleri tıklaması hiçbir koşulda tarayıcının varsayılan eylemini (gönderim) tetiklemez.
    event?.preventDefault();
    if (!current) return;
    if (missingRequired(current, answers)) {
      setBlockedId(current.id);
      stepRef.current?.focus();
      return;
    }
    goTo(step + 1);
  }

  /** Tek seçimli soruda bilinçli seçimden sonra (kilitli) sonraki soruya geç. */
  function maybeAutoAdvance(question: SurveyQuestion) {
    const now = Date.now();
    const deliberate =
      now - pointerAt.current < INTENT_WINDOW_MS || now - keyAt.current < INTENT_WINDOW_MS;
    pointerAt.current = 0;
    keyAt.current = 0;
    if (!shouldAutoAdvance({ type: question.type, index: step, total, deliberate })) return;
    // Kilit: bekleyen geçiş varsa ikinci geçiş planlanmaz (çift tık, çift olay).
    if (advanceTimer.current !== null) return;
    const target = step + 1;
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null;
      goTo(target);
    }, AUTO_ADVANCE_MS);
  }

  /** Son adım dışında Enter gönderim değil "İleri"dir (yazı alanında satır sonu kalır). */
  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || last) return;
    const target = event.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    event.preventDefault();
    goNext();
  }

  const stepAnimation =
    direction === "forward" ? styles.stepForward : direction === "back" ? styles.stepBack : "";
  const showAlert = Boolean(alertText) && (last || firstErrorStep(questions, fieldErrors) === step);

  return (
    <>
      <form
        action={action}
        className={styles.form}
        aria-busy={pending || undefined}
        aria-describedby={showAlert ? `${baseId}-alert` : undefined}
        onKeyDown={onFormKeyDown}
      >
        <p className={styles.authNotice}>{signedIn ? COPY.authNotice : COPY.anonymousNotice}</p>

        {showProgress ? (
          <div className={styles.progress}>
            <p className={styles.progressText}>{COPY.stepOf(step + 1, total)}</p>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label={COPY.progressLabel}
              aria-valuemin={1}
              aria-valuemax={total}
              aria-valuenow={step + 1}
              aria-valuetext={COPY.stepOf(step + 1, total)}
            >
              <div
                className={styles.progressFill}
                style={{ width: `${progressPercent(step, total)}%` }}
              />
            </div>
          </div>
        ) : null}

        {/* Ekran okuyucuya adım değişimi: yalnızca değişimde okunur. */}
        <p className={styles.srOnly} role="status" aria-live="polite">
          {current
            ? `${COPY.stepOf(step + 1, total)}: ${current.label}`
            : newsletterStep
              ? `${COPY.stepOf(step + 1, total)}: ${COPY.newsletterTitle}`
              : ""}
        </p>

        {questions.map((question, index) => {
          const name = fieldName(question.id);
          const given = answers[name] ?? [];

          // Görünmeyen sorular: cevapları gizli alan olarak forma yazılır (FormData eskisiyle aynı).
          if (index !== step) {
            if (isChoice(question.type)) {
              return given.map((value) => (
                <input key={`${name}-${value}`} type="hidden" name={name} value={value} />
              ));
            }
            return <input key={name} type="hidden" name={name} value={given[0] ?? ""} />;
          }

          const serverError = sameValues(values[name], given)
            ? fieldMessage(fieldErrors[question.id])
            : undefined;
          const error = blockedId === question.id ? COPY.errorRequired : serverError;
          const errorId = `${baseId}-${question.id}-error`;
          const optional = question.required ? "" : ` ${COPY.optional}`;

          let control: ReactNode;
          if (isChoice(question.type)) {
            const multiple = question.type === "multiple_choice";
            control = (
              <fieldset className={styles.fieldset} aria-describedby={error ? errorId : undefined}>
                <legend className={styles.legend}>
                  {question.label}
                  {optional}
                </legend>
                {question.description ? (
                  <p className={styles.hint}>{question.description}</p>
                ) : null}
                <div className={styles.choices}>
                  {question.options.map((option) => {
                    const value = String(option.id);
                    return (
                      <label
                        key={option.id}
                        className={styles.choice}
                        onPointerDown={() => {
                          pointerAt.current = Date.now();
                        }}
                      >
                        <input
                          type={multiple ? "checkbox" : "radio"}
                          name={name}
                          value={value}
                          required={question.required && !multiple}
                          checked={given.includes(value)}
                          aria-invalid={error ? true : undefined}
                          className={styles.choiceInput}
                          onKeyDown={(event) => {
                            if (event.key === " ") keyAt.current = Date.now();
                          }}
                          onChange={(event) =>
                            setAnswer(
                              name,
                              multiple
                                ? toggleValue(given, value, event.currentTarget.checked)
                                : [value],
                            )
                          }
                          // Aynı seçeneğe geri dönüp yeniden tıklamak `change` üretmez; geçiş `click`'te.
                          onClick={() => (multiple ? undefined : maybeAutoAdvance(question))}
                        />
                        <span className={styles.choiceLabel}>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
                {error ? (
                  <p id={errorId} role="alert" className={styles.errorText}>
                    {error}
                  </p>
                ) : null}
              </fieldset>
            );
          } else if (question.type === "short_text") {
            control = (
              <Input
                label={question.required ? question.label : `${question.label} ${COPY.optional}`}
                name={name}
                type="text"
                required={question.required}
                maxLength={500}
                autoComplete="off"
                {...(question.description ? { hint: question.description } : {})}
                value={given[0] ?? ""}
                onChange={(event) => setAnswer(name, [event.currentTarget.value])}
                {...(error ? { error } : {})}
              />
            );
          } else {
            const textareaId = `${baseId}-${question.id}`;
            const hintId = `${textareaId}-hint`;
            control = (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={textareaId}>
                  {question.label}
                  {optional}
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
                  value={given[0] ?? ""}
                  onChange={(event) => setAnswer(name, [event.currentTarget.value])}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={
                    [question.description ? hintId : null, error ? errorId : null]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  className={styles.textarea}
                />
                {error ? (
                  <p id={errorId} role="alert" className={styles.errorText}>
                    {error}
                  </p>
                ) : null}
              </div>
            );
          }

          return (
            <div
              // `key`: adım değişince kap yeniden kurulur ve geçiş animasyonu bir kez çalışır.
              key={`step-${question.id}`}
              ref={stepRef}
              tabIndex={-1}
              className={`${styles.step} ${stepAnimation}`}
            >
              {control}
            </div>
          );
        })}

        {newsletter ? (
          <>
            <input type="hidden" name={NEWSLETTER_STEP_FIELD} value="1" />
            {newsletterOn && newsletter.email ? (
              <input type="hidden" name={NEWSLETTER_OPT_IN_FIELD} value="1" />
            ) : null}
          </>
        ) : null}

        {newsletter && newsletterStep ? (
          <div
            key="step-newsletter"
            ref={stepRef}
            tabIndex={-1}
            className={`${styles.step} ${stepAnimation}`}
          >
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>{COPY.newsletterTitle}</legend>
              <p className={styles.hint}>{COPY.newsletterBody}</p>
              <p className={styles.newsletterEmail}>
                {newsletter.email ? (
                  <>
                    <span className={styles.hint}>{COPY.newsletterEmailLabel}</span>
                    <strong>{newsletter.email}</strong>
                  </>
                ) : (
                  <span className={styles.hint}>{COPY.newsletterNoEmail}</span>
                )}
              </p>
              <div className={styles.choices}>
                <label className={styles.choice}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={newsletterOn}
                    checked={newsletterOn}
                    disabled={!newsletter.email || pending}
                    className={styles.choiceInput}
                    onChange={(event) => setNewsletterOn(event.currentTarget.checked)}
                  />
                  <span className={styles.choiceLabel}>{COPY.newsletterToggle}</span>
                </label>
              </div>
            </fieldset>
          </div>
        ) : null}

        {showAlert ? (
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

        <div className={styles.wizardActions}>
          {step > 0 ? (
            <Button
              key="back"
              type="button"
              variant="secondary"
              size="lg"
              shape="pill"
              disabled={pending}
              onClick={() => goTo(step - 1)}
            >
              {COPY.back}
            </Button>
          ) : (
            <span />
          )}
          {/*
          `key`: İleri (type=button) ile Tamamla (type=submit) AYNI DOM düğmesi olmamalı.
          Aksi halde son-bir-önceki adımda İleri tıklaması düğmeyi tıklama bitmeden
          `submit`'e çevirir ve tarayıcı formu erken gönderir.
        */}
          {last ? (
            <Button
              key="finish"
              type="submit"
              variant="accent"
              size="lg"
              shape="pill"
              disabled={pending}
            >
              {pending ? COPY.submitting : COPY.finish}
            </Button>
          ) : (
            <Button
              key="next"
              type="button"
              variant="accent"
              size="lg"
              shape="pill"
              onClick={goNext}
            >
              {COPY.next}
            </Button>
          )}
        </div>

        <p className={styles.privacyNote}>
          {COPY.privacyNote} <a href="/gizlilik">{COPY.privacyLink}</a> {COPY.privacyNoteEnd}
        </p>
      </form>
      {skip}
    </>
  );
}
