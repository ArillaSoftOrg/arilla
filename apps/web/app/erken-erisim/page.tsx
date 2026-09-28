import { ADMIN_CONSOLE_PATH, canAccessProduct, getEarlyAccess, hasCapability } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Button } from "@arilla/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { logoutAction } from "../cikis-actions.ts";
import { COMING_SOON_COPY } from "../coming-soon-copy.ts";
import { EARLY_ACCESS_COPY } from "../early-access-copy.ts";
import { HOME_COPY } from "../home-copy.ts";
import { requireUser } from "../lib/dal.ts";
import actions from "../public-actions.module.css";
import { SubpageShell } from "../public-site-shell.tsx";
import { configuredSocialLinks, SITE_BRAND } from "../site-config.ts";
import styles from "../system-state.module.css";
import { joinEarlyAccessAction } from "./actions.ts";
import { earlyAccessState } from "./state.ts";

export const metadata: Metadata = {
  title: `Erken erişim – ${SITE_BRAND}`,
  robots: { index: false, follow: false },
};

const DATE_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

/**
 * P2 başarı ekranı (karar 0043 ile yenilendi): lansman öncesi normal
 * kullanıcı her girişten sonra buraya gelir (`postAuthRedirect`). Ürüne
 * erişebilen (moderatör, yönetici ya da ürün açıkken herkes) ana sayfaya
 * gider. Kaydı olmayan kullanıcı (P2'den önce açılmış oturum) buradan
 * listeye katılır; katılım idempotenttir.
 *
 * Ürüne giden hiçbir bağlantı yok. Hesap bağlantısı ve çıkış burada:
 * `/hesap` KVKK hakları (veri indirme, hesap silme) için ürün kapısının
 * dışında kalır.
 */
export default async function ErkenErisimPage() {
  const user = await requireUser();
  if (canAccessProduct(user)) {
    redirect("/");
  }
  // Lansman öncesi moderatör: personel listede değildir, ürünü de göremez
  // (karar 0043); yeri yönetim konsolu.
  if (hasCapability(user.role, "admin.access")) {
    redirect(ADMIN_CONSOLE_PATH);
  }
  const entry = await getEarlyAccess(getDatabase(), user.id);
  const state = earlyAccessState(entry);
  const socialLinks = configuredSocialLinks();

  return (
    <SubpageShell currentPath="/erken-erisim">
      <div className={styles.page}>
        <section className={styles.notFoundHero} aria-labelledby="erken-erisim-baslik">
          <p className={styles.code}>{EARLY_ACCESS_COPY.navStatus}</p>
          {entry ? (
            <div className={styles.text}>
              <h1 id="erken-erisim-baslik" className={styles.title}>
                {state === "just_joined"
                  ? EARLY_ACCESS_COPY.joinedTitle
                  : EARLY_ACCESS_COPY.returningTitle}
              </h1>
              <p className={styles.body}>
                {state === "just_joined"
                  ? EARLY_ACCESS_COPY.joinedBody
                  : EARLY_ACCESS_COPY.returningBody}
              </p>
              <p className={styles.hint}>
                {EARLY_ACCESS_COPY.joinedOn(DATE_FORMAT.format(entry.createdAt))}
              </p>
              <p className={styles.hint}>{EARLY_ACCESS_COPY.notYetOpen}</p>
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
            <a className={actions.secondary} href="/">
              {EARLY_ACCESS_COPY.backHome}
            </a>
            <a className={actions.secondary} href="/hesap">
              {HOME_COPY.navAccount}
            </a>
            <form action={logoutAction}>
              <button type="submit" className={actions.secondary}>
                {EARLY_ACCESS_COPY.logout}
              </button>
            </form>
          </div>
          {socialLinks.length > 0 ? (
            <nav className={styles.inlineLinks} aria-label={COMING_SOON_COPY.followTitle}>
              {socialLinks.map((link) => (
                <a key={link.network} href={link.href} rel="noopener noreferrer me" target="_blank">
                  {link.label}
                </a>
              ))}
            </nav>
          ) : null}
        </section>
      </div>
    </SubpageShell>
  );
}
