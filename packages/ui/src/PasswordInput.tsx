"use client";

import { type InputHTMLAttributes, useId, useState } from "react";
import styles from "./Input.module.css";
import { EyeIcon, EyeOffIcon } from "./icons.tsx";
import { joinClassNames } from "./layout.ts";

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  error?: string;
  hint?: string;
  /** Verilirse gorunurluk disaridan yonetilir (olusturulan sifreyi gostermek icin). */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  showLabel?: string;
  hideLabel?: string;
}

/**
 * `Input` ile ayni gorunum ve ipucu ve hata metinleri; sifre alani + goster/gizle dugmesi.
 * Varsayilan GIZLI. Dugme `type="button"` (formu gondermez), klavyeyle odaklanir,
 * `aria-pressed` ve degisen `aria-label` ile durumunu ekran okuyucuya soyler.
 * Dugme alanin icinde olsa da sirada girdiden sonra gelir; `autoComplete` ve
 * `name` cagirandan aynen girdiye gecer (parola yoneticileri etkilenmez).
 */
export function PasswordInput({
  label,
  error,
  hint,
  className,
  id,
  visible,
  onVisibleChange,
  showLabel = "Şifreyi göster",
  hideLabel = "Şifreyi gizle",
  "aria-describedby": describedBy,
  ...rest
}: PasswordInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [innerVisible, setInnerVisible] = useState(false);
  const shown = visible ?? innerVisible;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedByIds = [describedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

  const toggle = () => {
    const next = !shown;
    if (visible === undefined) setInnerVisible(next);
    onVisibleChange?.(next);
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <div className={styles.passwordWrap}>
        <input
          {...rest}
          id={inputId}
          type={shown ? "text" : "password"}
          className={joinClassNames(
            styles.input,
            styles.passwordInput,
            error && styles.error,
            className,
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedByIds}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          className={styles.passwordToggle}
          onClick={toggle}
          aria-pressed={shown}
          aria-controls={inputId}
          aria-label={shown ? hideLabel : showLabel}
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
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
