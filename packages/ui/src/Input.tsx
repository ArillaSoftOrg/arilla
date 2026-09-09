import { type InputHTMLAttributes, useId } from "react";
import styles from "./Input.module.css";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function Input({ label, error, className, id, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputClasses = [styles.input, error ? styles.error : undefined, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        className={inputClasses}
        aria-invalid={error ? true : undefined}
      />
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}
