import type { Metadata } from "next";
import Link from "next/link";
import formStyles from "../geri-bildirim/page.module.css";
import { verifySession } from "../lib/dal.ts";
import { PUBLIC_CONTACT_EMAIL, SITE_BRAND } from "../site-config.ts";
import { CONTACT_COPY as COPY } from "./contact-copy.ts";
import { ContactFormClient } from "./contact-form-client.tsx";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: `İletişim – ${SITE_BRAND}`,
  description: `${SITE_BRAND} ile ilgili soru, talep ve hata bildirimleriniz için iletişim formu.`,
  alternates: { canonical: "/iletisim" },
};

/**
 * `/iletisim` (docs/decisions/0061). Form `/geri-bildirim` ile aynı yazma
 * yoluna gider (`feedback` tablosu, `kind = 'contact'`). Ürün kapısının
 * dışında, giriş modali yok (karar 0002). Oturum yalnızca arayüzü ve ön
 * doldurmayı belirler; hesap bağlantısı server action'da yeniden okunur.
 *
 * E-posta kanalı (Faz 8.1) form çalışmasa da ulaşılabilir kalsın diye
 * formun altında durur; adres tek kaynaktan (`site-config.ts`).
 */
export default async function IletisimPage() {
  const user = await verifySession();

  return (
    <div className={formStyles.page}>
      <section className={formStyles.panel} aria-labelledby="iletisim-baslik">
        <header className={formStyles.intro}>
          <h1 id="iletisim-baslik" className={formStyles.title}>
            {COPY.title}
          </h1>
          <p className={formStyles.description}>{COPY.description}</p>
          <p className={styles.faqPrompt}>
            {COPY.faqPrompt} <Link href="/sss">{COPY.faqLink}</Link> {COPY.faqPromptEnd}
          </p>
        </header>
        <ContactFormClient
          signedIn={user !== null}
          defaultName={user?.displayName ?? ""}
          defaultEmail={user?.email ?? ""}
        />
        <p className={styles.emailAlternative}>
          {COPY.emailAlternative}{" "}
          <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`} className={styles.emailLink}>
            {PUBLIC_CONTACT_EMAIL}
          </a>
        </p>
      </section>
    </div>
  );
}
