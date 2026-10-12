import {
  EARLY_ACCESS_LOGIN_PATH,
  EARLY_ACCESS_PATH,
  type EarlyAccessProgress as EarlyAccessProgressData,
} from "@arilla/core";
import { ArrowRightIcon, ChevronRightIcon, PlusIcon, VisuallyHidden } from "@arilla/ui";
import styles from "./coming-soon.module.css";
import { BUILD_ITEMS, BUILD_UPDATED, COMING_SOON_COPY as copy } from "./coming-soon-copy.ts";
import { ComingSoonDemo } from "./coming-soon-demo.tsx";
import { ComingSoonSocial } from "./coming-soon-social.tsx";
import { EARLY_ACCESS_COPY } from "./early-access-copy.ts";
import { EarlyAccessProgress } from "./early-access-progress.tsx";
import { SUBPAGE_SECTION_LINKS } from "./home-footer-groups.ts";
import { MascotGuide } from "./mascot-guide.tsx";
import { MascotJourney } from "./mascot-hero-client.tsx";
import { PublicSiteShell } from "./public-site-shell.tsx";
import { configuredSocialLinks, SITE_BRAND } from "./site-config.ts";

/** Product access, enrollment and real progress remain server-owned. */
export function ComingSoonLanding({
  signedIn,
  progress,
}: {
  signedIn: boolean;
  progress?: EarlyAccessProgressData | null;
}) {
  const primaryHref = signedIn ? EARLY_ACCESS_PATH : EARLY_ACCESS_LOGIN_PATH;
  const primaryLabel = signedIn ? EARLY_ACCESS_COPY.viewStatus : EARLY_ACCESS_COPY.cta;
  const socialLinks = configuredSocialLinks();

  return (
    <PublicSiteShell
      links={SUBPAGE_SECTION_LINKS}
      showFooterSocial={false}
      compactFooter
      footerVariant="prelaunch"
    >
      <div className={styles.page}>
        <MascotJourney>
          <section className={styles.hero} aria-labelledby="yakinda-baslik">
            <div className={styles.heroIntro}>
              <h1 id="yakinda-baslik" className={styles.brandHeadline}>
                {SITE_BRAND}
              </h1>
              <p className={styles.heroHeadline}>{copy.headline}</p>
              <details className={styles.heroDetails}>
                <summary className={`${styles.disclosureToggle} ${styles.heroDetailsToggle}`}>
                  {copy.heroDetailsLabel}
                  <ChevronRightIcon className={styles.disclosureChevron} size={18} />
                </summary>
                <div className={styles.heroDetailsBody}>
                  <p>{copy.body}</p>
                  <p>{copy.stageNote}</p>
                </div>
              </details>
            </div>
            <div className={styles.welcomeStage}>
              <div className={`${styles.dialogue} ${styles.welcomeDialogue}`}>
                <span className={styles.dialogueGreeting}>{copy.greeting}</span>
                <details className={styles.greetingDisclosure}>
                  <summary className={`${styles.disclosureToggle} ${styles.greetingToggle}`}>
                    <VisuallyHidden>Karşılama notunu göster</VisuallyHidden>
                    <ChevronRightIcon className={styles.disclosureChevron} size={18} />
                  </summary>
                  <p>{copy.greetingBody}</p>
                </details>
              </div>
              <MascotGuide pose="welcome" priority />
            </div>
            <div className={styles.heroSignup}>
              <div className={styles.heroActions}>
                <a className={styles.primaryAction} href={primaryHref}>
                  {primaryLabel}
                  <ArrowRightIcon size={18} />
                </a>
                <a className={styles.secondaryAction} href="#nasil-calisacak">
                  {copy.howItWorksAnchor}
                  <ArrowRightIcon className={styles.downArrow} size={18} />
                </a>
              </div>
              <p className={styles.heroNote}>{signedIn ? copy.enrolledTitle : copy.ctaNote}</p>
              {!signedIn ? <p className={styles.privacyNote}>{copy.privacyNote}</p> : null}
              {progress ? (
                <div className={styles.progress}>
                  <EarlyAccessProgress progress={progress} prominent />
                  <details className={styles.progressDisclosure}>
                    <summary className={`${styles.disclosureToggle} ${styles.progressToggle}`}>
                      <span className={styles.progressGoal}>
                        {copy.progressGoal(new Intl.NumberFormat("tr-TR").format(progress.target))}
                      </span>
                      <ChevronRightIcon className={styles.disclosureChevron} size={18} />
                    </summary>
                    <p className={styles.progressNote}>{copy.progressNote}</p>
                  </details>
                </div>
              ) : (
                <p className={styles.heroNote}>{copy.availability}</p>
              )}
            </div>
          </section>

          <ComingSoonDemo />

          <div className={styles.details}>
            <section className={styles.build} aria-labelledby="gelistiriyoruz-baslik">
              <p className={styles.sectionEyebrow}>{copy.buildEyebrow}</p>
              <h2 id="gelistiriyoruz-baslik" className={styles.detailsTitle}>
                {copy.buildTitle}
              </h2>
              <p className={styles.sceneBody}>{copy.buildBody}</p>
              {/* biome-ignore lint/a11y/noRedundantRoles: WebKit drops list semantics with list-style:none. */}
              <ul role="list" className={styles.buildList}>
                {BUILD_ITEMS.map((item) => (
                  <li key={item.id} className={styles.buildItem}>
                    <span>{item.title}</span>
                    <span className={styles.buildStatus} data-done={item.status === "done"}>
                      <span aria-hidden="true" />
                      {item.status === "done" ? copy.buildStatusDone : copy.buildStatusInProgress}
                    </span>
                  </li>
                ))}
              </ul>
              {BUILD_UPDATED ? (
                <p className={styles.heroNote}>{copy.buildUpdated(BUILD_UPDATED)}</p>
              ) : null}
            </section>

            <section className={styles.faq} aria-labelledby="sorular-baslik">
              <p className={styles.sectionEyebrow}>{copy.faqEyebrow}</p>
              <h2 id="sorular-baslik" className={styles.detailsTitle}>
                {copy.faqTitle}
              </h2>
              {copy.questions.map((item) => (
                <details className={styles.question} key={item.question}>
                  <summary>
                    {item.question}
                    <PlusIcon size={18} />
                  </summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </section>
          </div>

          <ComingSoonSocial links={socialLinks} />
        </MascotJourney>
      </div>
    </PublicSiteShell>
  );
}
