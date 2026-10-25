import {
  checkResetTokenUsable,
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CREDENTIAL_COPY as COPY } from "../credential-copy.ts";
import { ResetPasswordForm } from "../credential-forms-client.tsx";
import { CredentialShell } from "../credential-shell.tsx";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "Yeni şifre belirle",
  robots: { index: false, follow: false },
  // Adres satırındaki token hiçbir istekte Referer ile dışarı gitmesin.
  referrer: "no-referrer",
};

/**
 * docs/routes.md `/giris/sifre-sifirla?token=...`. GET yan etkisizdir: token
 * yalnızca geçerli mi diye okunur, tüketilmez; tüketim formun POST'unda
 * (`resetPasswordAction`). Geçersiz bağlantıda form yerine yeni bağlantı
 * isteme yolu gösterilir.
 */
export default async function SifreSifirlaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) redirect("/giris/sifre-unuttum");

  let problem: string | undefined;
  try {
    await checkResetTokenUsable(getDatabase(), token);
  } catch (error) {
    if (error instanceof TokenExpiredError) problem = COPY.tokenExpired;
    else if (error instanceof TokenAlreadyUsedError || error instanceof TokenNotFoundError) {
      problem = COPY.tokenUsed;
    } else throw error;
  }

  return (
    <CredentialShell
      titleId="sifre-sifirla-baslik"
      title={COPY.resetTitle}
      notice={problem}
      footer={
        problem ? (
          <a className={styles.legal} href="/giris/sifre-unuttum">
            {COPY.requestNewLink}
          </a>
        ) : undefined
      }
    >
      {problem ? null : <ResetPasswordForm token={token} />}
    </CredentialShell>
  );
}
