"use client";

import { Button, Input, VisuallyHidden } from "@arilla/ui";
import { type ReactNode, useActionState } from "react";
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
  google: "Google ile devam edin",
  apple: "Apple ile devam edin",
  phone: "Telefon ile devam edin",
  unavailable: "şu an kullanılamıyor", // auth.provider_unavailable
} as const;

function GoogleMark() {
  return (
    <span className={styles.providerIcon} aria-hidden="true">
      <svg className={styles.googleMark} viewBox="0 0 24 24" focusable="false">
        <title>Google</title>
        <path
          fill="#4285f4"
          d="M23.49 12.27c0-.8-.07-1.57-.2-2.31H12v4.37h6.46a5.53 5.53 0 0 1-2.39 3.63v3h3.87c2.27-2.09 3.55-5.17 3.55-8.69Z"
        />
        <path
          fill="#34a853"
          d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3a7.24 7.24 0 0 1-10.78-3.8H1.3v3.09A12 12 0 0 0 12 24Z"
        />
        <path
          fill="#fbbc05"
          d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.3a12 12 0 0 0 0 10.76l3.99-3.09Z"
        />
        <path
          fill="#ea4335"
          d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.44-3.44A11.57 11.57 0 0 0 12 0 12 12 0 0 0 1.3 6.62l3.99 3.09A7.15 7.15 0 0 1 12 4.76Z"
        />
      </svg>
    </span>
  );
}

function AppleMark() {
  return (
    <span className={styles.providerIcon} aria-hidden="true">
      <svg className={styles.appleMark} viewBox="0 0 24 24" focusable="false">
        <title>Apple</title>
        <path
          fill="currentColor"
          d="M16.6 12.4c0-2.1 1.7-3.1 1.8-3.2-1-1.4-2.5-1.6-3-1.7-1.3-.1-2.5.8-3.2.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.8-.4 6.9 1.1 9.1.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.2-2.6 0 0-2.9-1.1-3-3.9ZM14.5 6.1c.6-.8 1.1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3Z"
        />
      </svg>
    </span>
  );
}

function PhoneMark() {
  return (
    <span className={styles.phoneChoice} aria-hidden="true">
      <span className={styles.flagUs}>
        <span />
      </span>
      <span className={styles.phoneChevron} />
      <span className={styles.phoneCode}>+1</span>
    </span>
  );
}

/** Sunucunun `authProviderAvailability()` sonucu; verilmezse hepsi açık sayılır. */
export interface ProviderAvailability {
  google: boolean;
  apple: boolean;
  phone: boolean;
}

/**
 * `next`: giriş sonrası dönüş yolu. Sunucu her adımda yeniden süzer
 * (`safeRedirectPath`); buradaki değer yalnızca taşınır.
 *
 * `availability`: yapılandırılmamış sağlayıcı bağlantı olmaz, "şu an
 * kullanılamıyor" notuyla devre dışı gösterilir - kullanıcı bozuk bir
 * akışa gönderilmez. Başlangıç route'ları aynı kontrolü ayrıca yapar.
 */
export function LoginFormClient({
  next,
  availability,
}: {
  next?: string;
  availability?: ProviderAvailability;
} = {}) {
  const [state, action, pending] = useActionState(requestLoginLinkAction, initialState);
  const withNext = (href: string) =>
    next && next !== "/" ? `${href}?next=${encodeURIComponent(next)}` : href;
  const provider = (
    key: keyof ProviderAvailability,
    href: string,
    label: string,
    mark: ReactNode,
  ) =>
    availability && !availability[key] ? (
      <span className={styles.providerButton} aria-disabled="true">
        {mark}
        {label} ({COPY.unavailable})
      </span>
    ) : (
      <a className={styles.providerButton} href={withNext(href)}>
        {mark}
        {label}
      </a>
    );

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
      {provider("google", "/giris/google", COPY.google, <GoogleMark />)}
      {provider("apple", "/giris/apple", COPY.apple, <AppleMark />)}
      {provider("phone", "/giris/telefon", COPY.phone, <PhoneMark />)}
      <form action={action} className={styles.form} aria-busy={pending || undefined}>
        {next && next !== "/" ? <input type="hidden" name="next" value={next} /> : null}
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
