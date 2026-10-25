"use client";

import { Button, Input, PasswordInput } from "@arilla/ui";
import { type ReactNode, useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  forgotPasswordAction,
  loginAction,
  registerAction,
  resendVerificationAction,
  resetPasswordAction,
} from "./credential-actions.ts";
import {
  CREDENTIAL_COPY as COPY,
  type CredentialErrorCode,
  credentialErrorText,
  PASSWORD_FIELD_ERRORS,
} from "./credential-copy.ts";
import type { CredentialFormState } from "./credential-errors.ts";
import { NewPasswordFields } from "./new-password-fields.tsx";
import styles from "./page.module.css";

const IDLE: CredentialFormState = { status: "idle" };

function SubmitButton({ label, pending }: { label: string; pending: string }) {
  const status = useFormStatus();
  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      fullWidth
      disabled={status.pending}
      aria-busy={status.pending}
    >
      {status.pending ? pending : label}
    </Button>
  );
}

/** Şifre alanının altında gösterilemeyen hatalar form başında uyarı olur. */
function FormNotice({ state }: { state: CredentialFormState }) {
  if (state.status !== "error" || PASSWORD_FIELD_ERRORS.has(state.code)) return null;
  return (
    <p role="alert" className={styles.notice}>
      {credentialErrorText(state.code)}
    </p>
  );
}

function passwordError(state: CredentialFormState): string | undefined {
  return state.status === "error" && PASSWORD_FIELD_ERRORS.has(state.code)
    ? credentialErrorText(state.code)
    : undefined;
}

function emailError(state: CredentialFormState): string | undefined {
  return state.status === "error" && state.code === "invalid_email"
    ? credentialErrorText(state.code)
    : undefined;
}

function errorCode(state: CredentialFormState): CredentialErrorCode | undefined {
  return state.status === "error" ? state.code : undefined;
}

function SentPanel({
  title,
  body,
  email,
  children,
}: {
  title: string;
  body: string;
  email: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.form} role="status">
      <h2 className={styles.sentTitle}>{title}</h2>
      <p className={styles.sentBody}>
        <strong>{email}</strong>
      </p>
      <p className={styles.sentBody}>{body}</p>
      {children}
    </div>
  );
}

export function ResendVerificationForm({
  email,
  next,
  heading,
}: {
  email?: string;
  next: string;
  heading?: boolean;
}) {
  const [state, action] = useActionState(resendVerificationAction, IDLE);
  const sentTo = state.status === "sent" ? state.email : undefined;
  return (
    <form action={action} className={styles.form}>
      {heading ? <p className={styles.sentBody}>{COPY.resendHeading}</p> : null}
      <input type="hidden" name="next" value={next} />
      <Input
        label={COPY.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        defaultValue={state.status === "error" ? state.email : email}
        required
        error={emailError(state)}
      />
      <FormNotice state={state} />
      {sentTo ? (
        <p role="status" className={styles.notice}>
          {COPY.resentBody}
        </p>
      ) : null}
      <SubmitButton label={COPY.resendSubmit} pending={COPY.resendPending} />
    </form>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(loginAction, IDLE);
  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="next" value={next} />
      <FormNotice state={state} />
      <Input
        label={COPY.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        defaultValue={state.status === "error" ? state.email : undefined}
        required
        error={emailError(state)}
      />
      <PasswordInput
        label={COPY.passwordLabel}
        name="password"
        autoComplete="current-password"
        required
        showLabel={COPY.showPassword}
        hideLabel={COPY.hidePassword}
      />
      <SubmitButton label={COPY.loginSubmit} pending={COPY.loginPending} />
    </form>
  );
}

export function RegisterForm({ next }: { next: string }) {
  const [state, action] = useActionState(registerAction, IDLE);
  if (state.status === "sent") {
    return (
      <SentPanel title={COPY.checkEmailTitle} body={COPY.checkEmailBody} email={state.email}>
        <ResendVerificationForm email={state.email} next={next} heading />
      </SentPanel>
    );
  }
  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="next" value={next} />
      <FormNotice state={state} />
      <Input
        label={COPY.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        defaultValue={state.status === "error" ? state.email : undefined}
        required
        error={emailError(state)}
      />
      <NewPasswordFields label={COPY.passwordLabel} error={passwordError(state)} />
      <SubmitButton label={COPY.registerSubmit} pending={COPY.registerPending} />
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, IDLE);
  if (state.status === "sent") {
    return (
      <SentPanel title={COPY.forgotSentTitle} body={COPY.forgotSentBody} email={state.email} />
    );
  }
  return (
    <form action={action} className={styles.form}>
      <FormNotice state={state} />
      <Input
        label={COPY.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        defaultValue={state.status === "error" ? state.email : undefined}
        required
        error={emailError(state)}
      />
      <SubmitButton label={COPY.forgotSubmit} pending={COPY.forgotPending} />
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, IDLE);
  const code = errorCode(state);
  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="token" value={token} />
      <FormNotice state={state} />
      {code === "token_expired" || code === "token_used" ? (
        <a className={styles.legal} href="/giris/sifre-unuttum">
          {COPY.requestNewLink}
        </a>
      ) : null}
      <NewPasswordFields
        label={COPY.newPasswordLabel}
        confirmName="confirm"
        error={passwordError(state)}
      />
      <SubmitButton label={COPY.resetSubmit} pending={COPY.resetPending} />
    </form>
  );
}
