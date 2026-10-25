import { authProviderAvailability } from "@arilla/core";
import type { Metadata } from "next";
import { CREDENTIAL_COPY as COPY } from "../credential-copy.ts";
import { ForgotPasswordForm } from "../credential-forms-client.tsx";
import { CredentialShell } from "../credential-shell.tsx";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "Şifreni sıfırla",
  robots: { index: false, follow: false },
};

/** docs/routes.md `/giris/sifre-unuttum`: şifre belirleme/sıfırlama bağlantısı iste. */
export default function SifreUnuttumPage() {
  const available = authProviderAvailability().email;
  return (
    <CredentialShell
      titleId="sifre-unuttum-baslik"
      title={COPY.forgotTitle}
      notice={available ? undefined : COPY.unavailableNotice}
      footer={
        <a className={styles.legal} href="/giris/eposta">
          {COPY.loginLink}
        </a>
      }
    >
      {available ? <ForgotPasswordForm /> : null}
    </CredentialShell>
  );
}
