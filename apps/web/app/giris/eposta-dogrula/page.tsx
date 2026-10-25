import { safeRedirectPath } from "@arilla/core";
import { Button } from "@arilla/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_BRAND } from "../../site-config.ts";
import { confirmVerificationAction } from "../credential-actions.ts";
import { CREDENTIAL_COPY as COPY } from "../credential-copy.ts";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "E-posta adresini doğrula",
  robots: { index: false, follow: false },
  // Adres satırındaki token hiçbir istekte Referer ile dışarı gitmesin.
  referrer: "no-referrer",
};

/**
 * docs/routes.md `/giris/eposta-dogrula?token=...`. GET hiçbir şeyi
 * değiştirmez ve veritabanına dokunmaz: yalnızca onay formunu gösterir.
 * E-posta tarayıcıları ve bağlantı önizlemeleri adresi açsa da token
 * tüketilmez; hesap, formun POST'u ile (`confirmVerificationAction`) açılır.
 */
export default async function EpostaDogrulaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  if (!token) redirect("/giris/eposta");

  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label={`${SITE_BRAND} ana sayfa`}>
        {SITE_BRAND}
      </a>
      <section className={styles.panel} aria-labelledby="eposta-dogrula-baslik">
        <h1 id="eposta-dogrula-baslik" className={styles.title}>
          {COPY.verifyTitle}
        </h1>
        <p className={styles.sentBody}>{COPY.verifyBody}</p>
        <form action={confirmVerificationAction} className={styles.form}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="next" value={safeRedirectPath(next)} />
          <Button type="submit" variant="primary" size="lg" fullWidth>
            {COPY.verifySubmit}
          </Button>
        </form>
      </section>
    </div>
  );
}
