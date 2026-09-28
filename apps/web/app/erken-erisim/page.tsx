import { canAccessProduct, getEarlyAccess } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Button } from "@arilla/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { logoutAction } from "../cikis-actions.ts";
import { EARLY_ACCESS_COPY } from "../early-access-copy.ts";
import { HOME_COPY } from "../home-copy.ts";
import { requireUser } from "../lib/dal.ts";
import actions from "../public-actions.module.css";
import { SubpageShell } from "../public-site-shell.tsx";
import styles from "../system-state.module.css";
import { joinEarlyAccessAction } from "./actions.ts";

export const metadata: Metadata = {
  title: "Erken erişim – Arilla",
  robots: { index: false, follow: false },
};

const DATE_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

/**
 * P2 başarı ekranı: lansman öncesi normal kullanıcı her girişten sonra
 * buraya gelir (`postAuthRedirect`). Ürüne erişebilen (moderatör, yönetici
 * ya da ürün açıkken herkes) ana sayfaya gider. Kaydı olmayan kullanıcı
 * (P2'den önce açılmış oturum) buradan listeye katılır.
 *
 * Hesap bağlantısı ve çıkış burada: `/hesap` KVKK hakları (veri indirme,
 * hesap silme) için ürün kapısının dışında kalır.
 */
export default async function ErkenErisimPage() {
  const user = await requireUser();
  if (canAccessProduct(user)) {
    redirect("/");
  }
  const entry = await getEarlyAccess(getDatabase(), user.id);

  return (
    <SubpageShell currentPath="/erken-erisim">
      <div className={styles.page}>
        <section className={styles.notFoundHero} aria-labelledby="erken-erisim-baslik">
          <p className={styles.code}>{EARLY_ACCESS_COPY.navStatus}</p>
          {entry ? (
            <div className={styles.text}>
              <h1 id="erken-erisim-baslik" className={styles.title}>
                {EARLY_ACCESS_COPY.joinedTitle}
              </h1>
              <p className={styles.body}>{EARLY_ACCESS_COPY.joinedBody}</p>
              <p className={styles.hint}>
                {EARLY_ACCESS_COPY.joinedOn(DATE_FORMAT.format(entry.createdAt))}
              </p>
            </div>
          ) : (
            <div className={styles.text}>
              <h1 id="erken-erisim-baslik" className={styles.title}>
                {EARLY_ACCESS_COPY.joinTitle}
              </h1>
              <p className={styles.body}>{EARLY_ACCESS_COPY.joinBody}</p>
              <form action={joinEarlyAccessAction}>
                <Button type="submit" variant="accent" shape="pill">
                  {EARLY_ACCESS_COPY.joinSubmit}
                </Button>
              </form>
            </div>
          )}
          <div className={actions.actions}>
            <a className={actions.secondary} href="/hesap">
              {HOME_COPY.navAccount}
            </a>
            <form action={logoutAction}>
              <button type="submit" className={actions.secondary}>
                Çıkış yap
              </button>
            </form>
          </div>
        </section>
      </div>
    </SubpageShell>
  );
}
