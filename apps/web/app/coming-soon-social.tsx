import styles from "./coming-soon.module.css";
import { COMING_SOON_COPY as copy } from "./coming-soon-copy.ts";
import { MascotGuide } from "./mascot-guide.tsx";
import type { SocialLink } from "./site-config.ts";
import { SocialMediaIcon } from "./social-media-icon.tsx";

export function ComingSoonSocial({ links }: { links: readonly SocialLink[] }) {
  if (links.length === 0) return null;

  return (
    <section className={styles.socialBand} aria-labelledby="takipte-kal-baslik">
      <div className={styles.socialCopy}>
        <p className={styles.sectionEyebrow}>{copy.socialEyebrow}</p>
        <h2 id="takipte-kal-baslik" className={styles.socialTitle}>
          {copy.socialTitle}
        </h2>
        <p className={styles.socialBody}>{copy.socialBody}</p>
      </div>
      <div className={styles.socialScene} data-guide-stage="">
        <MascotGuide pose="social" />
        <nav className={styles.socialLinks} aria-label={copy.followTitle}>
          {links.map((link) => (
            <a key={link.network} href={link.href} rel="noopener noreferrer me" target="_blank">
              <span className={styles.socialIcon} aria-hidden="true">
                <SocialMediaIcon network={link.network} size={27} />
              </span>
              <span className={styles.socialAccount}>
                <strong>{link.label}</strong>
                <small>
                  {link.network === "instagram"
                    ? "@manicepte.tr"
                    : link.network === "x"
                      ? "@ManiCeptetr"
                      : link.network === "linkedin"
                        ? "ManiCepte"
                        : copy.followTitle}
                </small>
              </span>
            </a>
          ))}
        </nav>
      </div>
    </section>
  );
}
