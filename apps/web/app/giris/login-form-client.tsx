"use client";

import { Button, Input, VisuallyHidden } from "@arilla/ui";
import { useActionState } from "react";
import { type RequestLoginLinkState, requestLoginLinkAction } from "./actions.ts";
import styles from "./page.module.css";

const initialState: RequestLoginLinkState = { status: "idle" };

/** Metinler docs/copy.md `auth.*` - anahtarlar yorumda. */
const COPY = {
  emailLabel: "E-posta adresin", // auth.email_label
  submit: "Bağlantı gönder", // auth.submit
  submitting: "Gönderiliyor…", // auth.submitting
  sentTitle: "Bağlantıyı gönderdik", // auth.link_sent_title
  sentBody: "E-postana bir giriş bağlantısı gönderdik. Bağlantı 15 dakika geçerli.", // auth.link_sent_body
  sentHint: "Birkaç dakika içinde gelmezse gereksiz klasörüne de göz at.", // auth.link_sent_hint
  rateLimited: "Az önce bir bağlantı gönderdik. Birkaç dakika sonra tekrar dene.", // auth.rate_limited
  invalidEmail: "Geçerli bir e-posta adresi gir.", // auth.invalid_email
  sendFailed: "Bağlantıyı şu an gönderemedik. Biraz sonra tekrar dene.", // auth.send_failed
  google: "Google ile devam et",
  divider: "veya",
} as const;

export function LoginFormClient() {
  const [state, action, pending] = useActionState(requestLoginLinkAction, initialState);

  if (state.status === "sent") {
    return (
      <div role="status" className={styles.sent}>
        <h2 className={styles.sentTitle}>{COPY.sentTitle}</h2>
        <p className={styles.sentBody}>{COPY.sentBody}</p>
        <p className={styles.sentHint}>{COPY.sentHint}</p>
      </div>
    );
  }

  // Alan hatasi (gecersiz e-posta) girdiye baglanir: `aria-invalid` +
  // `aria-describedby` Input'tan gelir. Oran siniri alanla ilgili degil,
  // form duzeyinde `role="alert"` ile duyurulur. Oturumun/hesabin var olup
  // olmadigini belli eden bir dal yok (docs/pages.md "/giris").
  const fieldError = state.status === "invalid_email" ? COPY.invalidEmail : undefined;

  return (
    <div className={styles.authChoices}>
      <a className={styles.googleButton} href="/giris/google">
        <span className={styles.googleMark} aria-hidden="true">
          G
        </span>
        {COPY.google}
      </a>
      <div className={styles.divider}>
        <span>{COPY.divider}</span>
      </div>
      <form action={action} className={styles.form} aria-busy={pending || undefined}>
        <Input
          label={COPY.emailLabel}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          error={fieldError}
        />
        {/* Girdinin altindaki hata metni canli bolge degil; gonderim sonrasi
            ekran okuyucuya ayrica duyurulur (gorsel tekrar yok). */}
        {fieldError ? <VisuallyHidden role="alert">{fieldError}</VisuallyHidden> : null}
        {state.status === "rate_limited" ? (
          <p role="alert" className={styles.notice}>
            {COPY.rateLimited}
          </p>
        ) : null}
        {/* E-posta gonderilemediyse "gonderdik" denmez (sessiz basari yok). */}
        {state.status === "send_failed" ? (
          <p role="alert" className={styles.notice}>
            {COPY.sendFailed}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" fullWidth disabled={pending}>
          {pending ? COPY.submitting : COPY.submit}
        </Button>
      </form>
    </div>
  );
}
