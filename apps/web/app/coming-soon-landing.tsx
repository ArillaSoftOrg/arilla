import {
  EARLY_ACCESS_LOGIN_PATH,
  EARLY_ACCESS_PATH,
  type EarlyAccessProgress as EarlyAccessProgressData,
} from "@arilla/core";
import { ArrowRightIcon, PlusIcon } from "@arilla/ui";
import styles from "./coming-soon.module.css";
import { BUILD_ITEMS, BUILD_UPDATED, COMING_SOON_COPY as copy } from "./coming-soon-copy.ts";
import { EARLY_ACCESS_COPY } from "./early-access-copy.ts";
import { EarlyAccessProgress } from "./early-access-progress.tsx";
import { SUBPAGE_SECTION_LINKS } from "./home-footer-groups.ts";
import { MascotJourney } from "./mascot-hero-client.tsx";
import { MascotPortrait } from "./mascot-portrait.tsx";
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
    <PublicSiteShell links={SUBPAGE_SECTION_LINKS}>
      <div className={styles.page}>
        <MascotJourney>
          <section className={styles.hero} aria-labelledby="yakinda-baslik">
            <div className={styles.heroIntro}>
              <p className={styles.eyebrow}>
                <span className={styles.statusDot} aria-hidden="true" />
                {copy.eyebrow}
                <span className={styles.eyebrowSeparator} aria-hidden="true">
                  /
                </span>
                {copy.status}
              </p>
              <h1 id="yakinda-baslik" className={styles.brandHeadline}>
                {SITE_BRAND}
              </h1>
              <p className={styles.heroHeadline}>{copy.headline}</p>
              <p className={styles.lead}>{copy.body}</p>
            </div>
            <div className={styles.welcomeStage}>
              <p className={`${styles.dialogue} ${styles.welcomeDialogue}`}>
                <span className={styles.dialogueGreeting}>{copy.greeting}</span>
                <span className={styles.greetingIntroduction}>{copy.greetingBody}</span>
                <span className={styles.greetingInvitation}>{copy.greetingInvitation}</span>
              </p>
              <MascotStop first />
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
              {progress ? (
                <div className={styles.progress}>
                  <EarlyAccessProgress progress={progress} prominent />
                  <p className={styles.progressGoal}>
                    {copy.progressGoal(new Intl.NumberFormat("tr-TR").format(progress.target))}
                  </p>
                  <p className={styles.progressNote}>{copy.progressNote}</p>
                </div>
              ) : (
                <p className={styles.heroNote}>{copy.availability}</p>
              )}
            </div>
          </section>

          <section id="nasil-calisacak" className={styles.scene} aria-labelledby="anlat-baslik">
            <div className={styles.sceneText}>
              <p className={styles.chapter}>
                <span>01</span>
                {copy.describeEyebrow}
              </p>
              <h2 id="anlat-baslik" className={styles.sceneTitle}>
                {copy.describeTitle}
              </h2>
              <p className={styles.sceneBody}>{copy.describeBody}</p>
              <figure className={styles.example}>
                <figcaption>{copy.exampleLabel}</figcaption>
                <blockquote>{copy.exampleQuery}</blockquote>
              </figure>
            </div>
            <div className={styles.sceneStage}>
              <p className={styles.dialogue}>{copy.describeDialogue}</p>
              <MascotStop />
            </div>
          </section>

          <section className={styles.scene} aria-labelledby="karar-baslik">
            <div className={styles.sceneText}>
              <p className={styles.chapter}>
                <span>02</span>
                {copy.compareEyebrow}
              </p>
              <h2 id="karar-baslik" className={styles.sceneTitle}>
                {copy.compareTitle}
              </h2>
              <p className={styles.sceneBody}>{copy.compareBody}</p>
              <dl className={styles.comparisonList}>
                {copy.comparisonPoints.map((point) => (
                  <div className={styles.comparisonPoint} key={point.title}>
                    <dt>{point.title}</dt>
                    <dd>{point.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className={styles.sceneStage}>
              <p className={styles.dialogue}>{copy.compareDialogue}</p>
              <MascotStop />
            </div>
          </section>
        </MascotJourney>

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
            {socialLinks.length > 0 ? (
              <nav className={styles.social} aria-label={copy.followTitle}>
                {socialLinks.map((link) => (
                  <a
                    key={link.network}
                    href={link.href}
                    rel="noopener noreferrer me"
                    target="_blank"
                  >
                    {link.label}
                    <ArrowRightIcon size={16} />
                  </a>
                ))}
              </nav>
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
      </div>
    </PublicSiteShell>
  );
}

/** Each stop stays visible without JavaScript and with reduced motion. */
function MascotStop({ first = false }: { first?: boolean }) {
  return (
    <div className={styles.mascotStop} data-mascot-stop="" aria-hidden="true">
      <MascotPortrait first={first} />
    </div>
  );
}
