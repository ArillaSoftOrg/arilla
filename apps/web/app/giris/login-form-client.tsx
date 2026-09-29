"use client";

import type { ReactNode } from "react";
import styles from "./page.module.css";

/**
 * Giriş ekranı yalnızca sosyal girişi gösterir: Google ve Apple.
 *
 * E-posta bağlantısı ve telefonla giriş arayüzden kaldırıldı; backend'leri
 * (`requestLoginLinkAction`, `/giris/dogrula`, `/giris/telefon/*`, core
 * `auth` modülleri, tablolar) duruyor ve ileride yeniden açılabilir.
 * Metinler docs/copy.md `auth.*`.
 */
const COPY = {
  google: "Google ile devam edin",
  apple: "Apple ile devam edin",
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

/** Sunucunun `authProviderAvailability()` sonucu; verilmezse ikisi de açık sayılır. */
export interface ProviderAvailability {
  google: boolean;
  apple: boolean;
}

/**
 * `next`: giriş sonrası dönüş yolu. Sunucu her adımda yeniden süzer
 * (`safeRedirectPath`); buradaki değer yalnızca taşınır. Yönetim girişi
 * (`/yonetim/giris`) aynı bileşeni `/yonetim` altındaki bir `next` ile kullanır.
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

  return (
    <div className={styles.authChoices}>
      {provider("google", "/giris/google", COPY.google, <GoogleMark />)}
      {provider("apple", "/giris/apple", COPY.apple, <AppleMark />)}
    </div>
  );
}
