"use client";

import { Button, Input } from "@arilla/ui";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  CREDENTIAL_COPY as COPY,
  credentialErrorText,
  PASSWORD_FIELD_ERRORS,
} from "../../giris/credential-copy.ts";
import { changePasswordAction, requestPasswordSetupAction } from "./actions.ts";
import styles from "./page.module.css";

function Submit({ label, pending }: { label: string; pending: string }) {
  const status = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={status.pending} aria-busy={status.pending}>
      {status.pending ? pending : label}
    </Button>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, { status: "idle" });
  const error = state.status === "error" ? state : undefined;
  const fieldError = error && PASSWORD_FIELD_ERRORS.has(error.code) ? error.code : undefined;

  return (
    <form action={action} className={styles.form}>
      {state.status === "changed" ? (
        <p role="status" className={styles.notice}>
          {COPY.changeDone}
        </p>
      ) : null}
      {error && !fieldError && error.code !== "wrong_current" ? (
        <p role="alert" className={styles.notice}>
          {credentialErrorText(error.code)}
        </p>
      ) : null}
      <Input
        label={COPY.currentPasswordLabel}
        name="current"
        type="password"
        autoComplete="current-password"
        required
        error={error?.code === "wrong_current" ? COPY.wrongCurrent : undefined}
      />
      <Input
        label={COPY.newPasswordLabel}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        maxLength={128}
        required
        hint={COPY.passwordHint}
        error={fieldError ? credentialErrorText(fieldError) : undefined}
      />
      <Input
        label={COPY.confirmPasswordLabel}
        name="confirm"
        type="password"
        autoComplete="new-password"
        minLength={10}
        maxLength={128}
        required
      />
      <Submit label={COPY.changeSubmit} pending={COPY.changePending} />
    </form>
  );
}

export function SetupPasswordForm() {
  const [state, action] = useActionState(requestPasswordSetupAction, { status: "idle" });
  return (
    <form action={action} className={styles.form}>
      {state.status === "sent" ? (
        <p role="status" className={styles.notice}>
          {COPY.setupDone}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className={styles.notice}>
          {credentialErrorText(state.code)}
        </p>
      ) : null}
      <Submit label={COPY.setupSubmit} pending={COPY.setupPending} />
    </form>
  );
}
