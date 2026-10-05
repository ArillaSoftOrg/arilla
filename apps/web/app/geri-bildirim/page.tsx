import type { Metadata } from "next";
import { verifySession } from "../lib/dal.ts";
import { SubpageShell } from "../public-site-shell.tsx";
import { FEEDBACK_COPY } from "./feedback-copy.ts";
import { FeedbackFormClient } from "./feedback-form-client.tsx";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: FEEDBACK_COPY.metaTitle,
  description: FEEDBACK_COPY.metaDescription,
  alternates: { canonical: "/geri-bildirim" },
  // Form sayfasi: arama sonucunda degeri yok, bagliliklari izlenebilir.
  robots: { index: false, follow: true },
};

/**
 * `/geri-bildirim` (docs/decisions/0045). Urun kapisinin disinda: lansman
 * oncesi anonim ziyaretci de, erken erisim uyesi de gonderebilir. Giris
 * modali yok (karar 0002). Oturum yalnizca arayuzu belirler; kimlik
 * server action'da yeniden okunur.
 */
export default async function GeriBildirimPage() {
  const user = await verifySession();

  return (
    <SubpageShell currentPath="/geri-bildirim">
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="geri-bildirim-baslik">
          <header className={styles.intro}>
            <h1 id="geri-bildirim-baslik" className={styles.title}>
              {FEEDBACK_COPY.title}
            </h1>
            <p className={styles.description}>{FEEDBACK_COPY.description}</p>
          </header>
          <FeedbackFormClient signedIn={user !== null} />
        </section>
      </div>
    </SubpageShell>
  );
}
