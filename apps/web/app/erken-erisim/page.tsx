import {
  ADMIN_CONSOLE_PATH,
  canAccessProduct,
  getEarlyAccess,
  getOnboardingOffer,
  hasCapability,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Button } from "@arilla/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SURVEY_COPY } from "../anket/survey-copy.ts";
import { logoutAction } from "../cikis-actions.ts";
import { COMING_SOON_COPY } from "../coming-soon-copy.ts";
import { EARLY_ACCESS_COPY } from "../early-access-copy.ts";
import { EarlyAccessProgress } from "../early-access-progress.tsx";
import { FEEDBACK_COPY } from "../geri-bildirim/feedback-copy.ts";
import { HOME_COPY } from "../home-copy.ts";
import { requireUser } from "../lib/dal.ts";
import { loadEarlyAccessProgress } from "../lib/early-access-progress.ts";
import { SubpageShell } from "../public-site-shell.tsx";
import { configuredSocialLinks, SITE_BRAND } from "../site-config.ts";
import { joinEarlyAccessAction } from "./actions.ts";
import styles from "./page.module.css";
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

const BENEFITS = [
  {
    title: "Benzer ürünleri bul",
    body: "Aradığın ürünü tarif ederek ya da linkle daha yakın alternatiflere ulaş.",
  },
  {
    title: "Fiyatları karşılaştır",
    body: "Farklı mağazalardaki seçenekleri tek yerde görmeye hazır ol.",
  },
  {
    title: "Fırsatları kaçırma",
    body: "ManiCepte açıldığında erken erişim hesabınla devam et.",
  },
] as const;

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
  // Onboarding formu (karar 0058): ilk katılımda bir kez forma yönlendirilir;
  // "Şimdilik geç" kayıt bırakır, bir daha otomatik yönlendirilmez ve erken
  // erişim kaydına dokunulmaz. Atlayan kullanıcı Hesabım'dan doldurabilir.
  const onboarding = entry ? await getOnboardingOffer(getDatabase(), user.id) : null;
  if (onboarding && !onboarding.skipped && state === "just_joined") {
    redirect(`/anket/${onboarding.slug}`);
  }
  const socialLinks = configuredSocialLinks();
  const progress = await loadEarlyAccessProgress();

  return (
    <SubpageShell currentPath="/erken-erisim">
      <div className={styles.page}>
        <section className={styles.hero} aria-labelledby="erken-erisim-baslik">
          {entry ? (
            <>
              <div className={styles.statusBlock}>
                <span className={styles.successMark} aria-hidden="true" />
                <p className={styles.eyebrow}>{EARLY_ACCESS_COPY.navStatus}</p>
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
                <div className={styles.metaRow}>
                  <span className={styles.dateBadge}>
                    {EARLY_ACCESS_COPY.joinedOn(DATE_FORMAT.format(entry.createdAt))}
                  </span>
                </div>
              </div>

              <div className={styles.nextStep}>
                <p className={styles.nextStepTitle}>Sırada ne var?</p>
                <p className={styles.hint}>{EARLY_ACCESS_COPY.notYetOpen}</p>
              </div>

              <section className={styles.benefitGrid} aria-label="ManiCepte ile yapabileceklerin">
                {BENEFITS.map((benefit) => (
                  <article key={benefit.title} className={styles.benefitItem}>
                    <span className={styles.benefitDot} aria-hidden="true" />
                    <div>
                      <h2 className={styles.benefitTitle}>{benefit.title}</h2>
                      <p className={styles.benefitBody}>{benefit.body}</p>
                    </div>
                  </article>
                ))}
              </section>

              {onboarding ? (
                <div className={styles.feedbackPrompt}>
                  <p className={styles.feedbackText}>{SURVEY_COPY.onboardingPrompt}</p>
                  <a className={styles.feedbackLink} href={`/anket/${onboarding.slug}`}>
                    {SURVEY_COPY.onboardingCta}
                  </a>
                </div>
              ) : null}

              {/* İkincil eylem: ana eylem hiyerarşisinin (aşağıdaki düğmeler)
                  üstüne çıkmaz, ayrı bir not satırı olarak durur (karar 0045). */}
              <div className={styles.feedbackPrompt}>
                <p className={styles.feedbackText}>{FEEDBACK_COPY.earlyAccessPrompt}</p>
                <a className={styles.feedbackLink} href="/geri-bildirim">
                  {FEEDBACK_COPY.submit}
                </a>
              </div>
            </>
          ) : (
            <div className={styles.statusBlock}>
              <span className={styles.successMark} aria-hidden="true" />
              <p className={styles.eyebrow}>{EARLY_ACCESS_COPY.navStatus}</p>
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
          {progress ? <EarlyAccessProgress progress={progress} /> : null}
          <div className={styles.actions}>
            <a className={styles.primaryAction} href="/">
              {EARLY_ACCESS_COPY.backHome}
            </a>
            <a className={styles.secondaryAction} href="/hesap">
              {HOME_COPY.navAccount}
            </a>
            <form action={logoutAction}>
              <button type="submit" className={styles.secondaryAction}>
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
