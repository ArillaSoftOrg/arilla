import { authProviderAvailability, safeRedirectPath } from "@arilla/core";
import type { Metadata } from "next";
import { CREDENTIAL_COPY as COPY } from "../credential-copy.ts";
import { RegisterForm } from "../credential-forms-client.tsx";
import { CredentialShell, LegalNote, withNext } from "../credential-shell.tsx";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "Hesap oluştur",
  robots: { index: false, follow: false },
};

/** docs/routes.md `/giris/kayit`: e-posta + şifre ile kayıt; hesap e-posta doğrulanınca açılır. */
export default async function KayitPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const safeNext = safeRedirectPath((await searchParams).next);
  const available = authProviderAvailability().email;

  return (
    <CredentialShell
      titleId="kayit-baslik"
      title={COPY.registerTitle}
      notice={available ? undefined : COPY.unavailableNotice}
      footer={
        <a className={styles.legal} href={withNext("/giris/eposta", safeNext)}>
          {COPY.loginLink}
        </a>
      }
    >
      {available ? <RegisterForm next={safeNext} /> : null}
      {available ? <LegalNote /> : null}
    </CredentialShell>
  );
}
