import { hasPasswordCredential, isStaffRole } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CREDENTIAL_COPY as COPY } from "../../giris/credential-copy.ts";
import { requireUser } from "../../lib/dal.ts";
import styles from "./page.module.css";
import { ChangePasswordForm, SetupPasswordForm } from "./sifre-forms-client.tsx";

export const metadata: Metadata = {
  title: "Şifre",
  robots: { index: false, follow: false },
};

/**
 * docs/routes.md `/hesap/sifre` (karar 0150): şifresi olan hesap şifresini
 * değiştirir (bu oturum dışındaki oturumlar kapanır); şifresi olmayan hesap
 * (yalnız Google/Apple) kendi adresine şifre belirleme bağlantısı ister.
 * Personel hesapları şifre kullanmaz.
 */
export default async function SifrePage() {
  const user = await requireUser();
  if (isStaffRole(user.role) || !user.email) redirect("/hesap");
  const hasPassword = await hasPasswordCredential(getDatabase(), user.id);

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Konum">
        <Link href="/hesap" className={styles.link}>
          Hesabım
        </Link>{" "}
        › {COPY.accountPasswordTitle}
      </nav>
      <h1 className={styles.title}>{hasPassword ? COPY.changeTitle : COPY.setupTitle}</h1>
      {hasPassword ? null : <p className={styles.text}>{COPY.setupBody}</p>}
      {hasPassword ? <ChangePasswordForm /> : <SetupPasswordForm />}
    </div>
  );
}
