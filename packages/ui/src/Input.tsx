import { type InputHTMLAttributes, useId } from "react";
import styles from "./Input.module.css";
import { joinClassNames } from "./layout.ts";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  /** Opsiyonel yardim metni; etiketin altinda degil, girdinin altinda durur. */
  hint?: string;
}

export function Input({
  label,
  error,
  hint,
  className,
  id,
  "aria-describedby": describedBy,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedByIds = [describedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        className={joinClassNames(styles.input, error && styles.error, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds}
      />
      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.errorText}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
