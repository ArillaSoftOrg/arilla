import { authProviderAvailability, safeRedirectPath } from "@arilla/core";
import type { Metadata } from "next";
import { CREDENTIAL_COPY as COPY, LOGIN_PAGE_NOTICES } from "../credential-copy.ts";
import { LoginForm, ResendVerificationForm } from "../credential-forms-client.tsx";
import { CredentialShell, withNext } from "../credential-shell.tsx";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "E-posta ile giriş",
  robots: { index: false, follow: false },
};

/**
 * docs/routes.md `/giris/eposta`: e-posta + şifre ile giriş (karar 0150).
 * Doğrulama bağlantısı sonuçları ve şifre sıfırlama başarısı `?durum=` ile döner.
 */
export default async function EpostaGirisPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string; next?: string }>;
}) {
  const { durum, next } = await searchParams;
  const safeNext = safeRedirectPath(next);
  const available = authProviderAvailability().email;
  // Süresi dolmuş/geçersiz doğrulama bağlantısı: yeniden gönderme formu açık gelir.
  const verifyProblem = durum === "suresi_doldu" || durum === "gecersiz";
  const notice = !available
    ? COPY.unavailableNotice
    : durum
      ? LOGIN_PAGE_NOTICES[durum]
      : undefined;

  return (
    <CredentialShell
      titleId="eposta-giris-baslik"
      title={COPY.loginTitle}
      notice={notice}
      noticeRole={durum === "sifre_degisti" ? "status" : "alert"}
      footer={
        <>
          <a className={styles.legal} href={withNext("/giris/kayit", safeNext)}>
            {COPY.registerLink}
          </a>
          <a className={styles.legal} href="/giris/sifre-unuttum">
            {COPY.forgotLink}
          </a>
        </>
      }
    >
      {available ? (
        <>
          <LoginForm next={safeNext} />
          <details className={styles.resendDetails} open={verifyProblem || undefined}>
            <summary>{COPY.resendHeading}</summary>
            <ResendVerificationForm next={safeNext} />
          </details>
        </>
      ) : null}
    </CredentialShell>
  );
}
