import {
  EARLY_ACCESS_LOGIN_PATH,
  EARLY_ACCESS_PATH,
  type EarlyAccessProgress as EarlyAccessProgressData,
} from "@arilla/core";
import { ArrowRightIcon, ImageIcon, LinkIcon, SearchIcon } from "@arilla/ui";
import styles from "./coming-soon.module.css";
import { BUILD_ITEMS, BUILD_UPDATED, COMING_SOON_COPY } from "./coming-soon-copy.ts";
import { EARLY_ACCESS_COPY } from "./early-access-copy.ts";
import { EarlyAccessProgress } from "./early-access-progress.tsx";
import { SUBPAGE_SECTION_LINKS } from "./home-footer-groups.ts";
import { PublicSiteShell } from "./public-site-shell.tsx";
import { configuredSocialLinks, SITE_BRAND } from "./site-config.ts";

const HOW_IT_WORKS_ID = "nasil-calisacak";

/**
 * Lansman öncesi landing (karar 0043). Ürün kapalıyken (`PRODUCT_ACCESS`
 * `open` değil) kapıdan geçemeyen herkese ana sayfa olarak gösterilir.
 *
 * Yalnızca tanıtım: veri çekmez, arama/AI/ürün servisi çağırmaz, form ya da
 * istemci betiği yoktur. Tek eylem mevcut giriş akışıdır; kayıt girişin
 * kendisinde yazılır. Görseller dekoratiftir (`aria-hidden`), gerçek ürün,
 * fiyat ya da sonuç gibi görünmez.
 */
export function ComingSoonLanding({
  signedIn,
  progress,
}: {
  signedIn: boolean;
  /** Gerçek erken erişim sayısı (karar 0065); yoksa çubuk gösterilmez. */
  progress?: EarlyAccessProgressData | null;
}) {
  const primaryHref = signedIn ? EARLY_ACCESS_PATH : EARLY_ACCESS_LOGIN_PATH;
  const primaryLabel = signedIn ? EARLY_ACCESS_COPY.viewStatus : EARLY_ACCESS_COPY.cta;
  const socialLinks = configuredSocialLinks();

  return (
    <PublicSiteShell links={SUBPAGE_SECTION_LINKS}>
      <div className={styles.page}>
        <section className={styles.hero} aria-labelledby="yakinda-baslik">
          <div className={styles.heroText}>
            <p className={styles.eyebrow}>
              <span className={styles.eyebrowDot} aria-hidden="true" />
              {COMING_SOON_COPY.eyebrow}
            </p>
            <p className={styles.status}>{COMING_SOON_COPY.status}</p>
            <h1 id="yakinda-baslik" className={styles.headline}>
              {COMING_SOON_COPY.headline}
            </h1>
            <p className={styles.lead}>{COMING_SOON_COPY.body}</p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href={primaryHref}>
                {primaryLabel}
                <ArrowRightIcon className={styles.actionIcon} size={18} />
              </a>
              <a className={styles.secondaryAction} href={`#${HOW_IT_WORKS_ID}`}>
                {COMING_SOON_COPY.howItWorksAnchor}
              </a>
            </div>
            <p className={styles.heroNote}>
              {signedIn ? EARLY_ACCESS_COPY.inList : COMING_SOON_COPY.ctaNote}
            </p>
            {progress ? <EarlyAccessProgress progress={progress} /> : null}
          </div>
          <HeroVisual />
        </section>

        <section className={styles.section} aria-labelledby="neler-baslik">
          <h2 id="neler-baslik" className={styles.sectionTitle}>
            {COMING_SOON_COPY.benefitsTitle}
          </h2>
          {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
          <ul role="list" className={styles.benefits}>
            {COMING_SOON_COPY.benefits.map((benefit, index) => (
              <li key={benefit.id} className={styles.benefit}>
                <span className={styles.benefitIndex} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className={styles.benefitTitle}>{benefit.title}</h3>
                <p className={styles.benefitBody}>{benefit.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section
          id={HOW_IT_WORKS_ID}
          className={`${styles.section} ${styles.anchored}`}
          aria-labelledby="nasil-calisacak-baslik"
        >
          <div className={styles.sectionIntro}>
            <h2 id="nasil-calisacak-baslik" className={styles.sectionTitle}>
              {COMING_SOON_COPY.howItWorksTitle}
            </h2>
            <p className={styles.sectionBody}>{COMING_SOON_COPY.howItWorksBody}</p>
          </div>
          <ol className={styles.steps}>
            {COMING_SOON_COPY.steps.map((step, index) => (
              <li key={step.id} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden="true">
                  {index + 1}
                </span>
                <div className={styles.stepText}>
                  <h3 className={styles.stepTitle}>{step.title}</h3>
                  <p className={styles.stepBody}>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.build} aria-labelledby="gelistiriyoruz-baslik">
          <div className={styles.buildIntro}>
            <h2 id="gelistiriyoruz-baslik" className={styles.buildTitle}>
              {COMING_SOON_COPY.buildTitle}
            </h2>
            <p className={styles.sectionBody}>{COMING_SOON_COPY.buildBody}</p>
          </div>
          {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
          <ul role="list" className={styles.buildList}>
            {BUILD_ITEMS.map((item) => (
              <li key={item.id} className={styles.buildItem}>
                <span className={styles.buildItemTitle}>{item.title}</span>
                <span
                  className={`${styles.buildBadge} ${
                    item.status === "done" ? styles.buildBadgeDone : styles.buildBadgeProgress
                  }`}
                >
                  {item.status === "done"
                    ? COMING_SOON_COPY.buildStatusDone
                    : COMING_SOON_COPY.buildStatusInProgress}
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.buildMeta}>
            {BUILD_UPDATED ? (
              <p className={styles.buildUpdated}>{COMING_SOON_COPY.buildUpdated(BUILD_UPDATED)}</p>
            ) : null}
            {socialLinks.length > 0 ? (
              <nav className={styles.social} aria-label={COMING_SOON_COPY.followTitle}>
                <span className={styles.socialTitle}>{COMING_SOON_COPY.followTitle}</span>
                {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
                <ul role="list" className={styles.socialList}>
                  {socialLinks.map((link) => (
                    <li key={link.network}>
                      <a
                        className={styles.socialLink}
                        href={link.href}
                        rel="noopener noreferrer me"
                        target="_blank"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </section>

        {signedIn ? null : (
          <section className={styles.closing} aria-labelledby="katil-baslik">
            <h2 id="katil-baslik" className={styles.closingTitle}>
              {COMING_SOON_COPY.closingTitle}
            </h2>
            <p className={styles.closingBody}>{COMING_SOON_COPY.closingBody}</p>
            <a className={styles.closingAction} href={EARLY_ACCESS_LOGIN_PATH}>
              {EARLY_ACCESS_COPY.cta}
              <ArrowRightIcon className={styles.actionIcon} size={18} />
            </a>
          </section>
        )}
      </div>
    </PublicSiteShell>
  );
}

/**
 * Dekoratif: üç başlangıç yolu (tarif, fotoğraf, bağlantı) tek noktada
 * birleşiyor. Etkileşimli değil, odaklanamaz; ürün, fiyat ya da sonuç
 * göstermez.
 */
function HeroVisual() {
  return (
    <div className={styles.visual} aria-hidden="true">
      <div className={styles.visualGrid} />
      <div className={styles.visualStack}>
        <span className={`${styles.visualChip} ${styles.visualChipA}`}>
          <SearchIcon className={styles.visualIcon} size={18} />
          Tarif et
        </span>
        <span className={`${styles.visualChip} ${styles.visualChipB}`}>
          <ImageIcon className={styles.visualIcon} size={18} />
          Fotoğraf
        </span>
        <span className={`${styles.visualChip} ${styles.visualChipC}`}>
          <LinkIcon className={styles.visualIcon} size={18} />
          Bağlantı
        </span>
      </div>
      <div className={styles.visualCore}>
        <span className={styles.visualMark}>{SITE_BRAND.slice(0, 1)}</span>
        <span className={styles.visualSoon}>{COMING_SOON_COPY.eyebrow}</span>
      </div>
    </div>
  );
}
