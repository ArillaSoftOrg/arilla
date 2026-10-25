"use client";

import { PasswordInput } from "@arilla/ui";
import { useState } from "react";
import { CREDENTIAL_COPY as COPY } from "./credential-copy.ts";
import { generatePassword } from "./generate-password.ts";
import styles from "./page.module.css";

/** Safari/iOS parola kuralı ipucu; backend politikasıyla aynı (10..128). */
const PASSWORD_RULES = { passwordrules: "minlength: 10; maxlength: 128;" } as Record<
  string,
  string
>;

/**
 * Yeni şifre alanı (kayıt, sıfırlama, değiştirme): `autocomplete="new-password"`,
 * göster/gizle ve "Güçlü şifre oluştur". Üretilen şifre yalnızca bu bileşenin
 * durumunda ve form alanında durur; sunucuya yalnızca kullanıcı formu gönderince,
 * normal şifre alanı olarak gider. `confirmName` verilirse tekrar alanı da dolar.
 */
export function NewPasswordFields({
  label,
  confirmName,
  error,
  hint = COPY.passwordHint,
  autoFocus,
}: {
  label: string;
  /** Verilirse "Şifreyi tekrar gir" alanı eklenir. */
  confirmName?: string;
  error?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<string>("");

  const generate = () => {
    const next = generatePassword();
    setPassword(next);
    setConfirm(next);
    setVisible(true);
    setStatus(COPY.generatedNotice);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setStatus(COPY.copiedNotice);
    } catch {
      setStatus(COPY.copyFailedNotice);
    }
  };

  return (
    <>
      <PasswordInput
        label={label}
        name="password"
        autoComplete="new-password"
        minLength={10}
        maxLength={128}
        required
        autoFocus={autoFocus}
        hint={hint}
        error={error}
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setStatus("");
        }}
        visible={visible}
        onVisibleChange={setVisible}
        showLabel={COPY.showPassword}
        hideLabel={COPY.hidePassword}
        {...PASSWORD_RULES}
      />
      <div className={styles.passwordTools}>
        <button type="button" className={styles.textButton} onClick={generate}>
          {COPY.generatePassword}
        </button>
        {password ? (
          <button type="button" className={styles.textButton} onClick={copy}>
            {COPY.copyPassword}
          </button>
        ) : null}
      </div>
      {/* Ekran okuyucuya durum: oluşturuldu / kopyalandı. Şifrenin kendisi okunmaz. */}
      <p role="status" aria-live="polite" className={styles.passwordStatus}>
        {status}
      </p>
      {confirmName ? (
        <PasswordInput
          label={COPY.confirmPasswordLabel}
          name={confirmName}
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          visible={visible}
          onVisibleChange={setVisible}
          showLabel={COPY.showPassword}
          hideLabel={COPY.hidePassword}
          {...PASSWORD_RULES}
        />
      ) : null}
    </>
  );
}
