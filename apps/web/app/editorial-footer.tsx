import type { FooterGroup } from "@arilla/ui";
import styles from "./editorial-footer.module.css";

export interface EditorialFooterProps {
  brandLabel: string;
  groups: readonly FooterGroup[];
  affiliateNotice: string;
  affiliateLink: { label: string; href: string };
  priceDisclaimer: string;
  copyrightLabel: string;
  legalLinks: readonly { label: string; href: string }[];
}

/**
 * Editoryal sayfalar (/hakkinda, /blog, /ortakliklar) icin sade footer:
 * iki sutunlu link gruplari, aciklama satirlari, telif + yasal satir ve
 * altta soluk dev wordmark. Veri `PublicSiteShell`'den gelir - route uydurmaz.
 */
export function EditorialFooter({
  brandLabel,
  groups,
  affiliateNotice,
  affiliateLink,
  priceDisclaimer,
  copyrightLabel,
  legalLinks,
}: EditorialFooterProps) {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.groups}>
          {groups.map((group) => (
            <nav key={group.title} aria-label={group.title} className={styles.group}>
              <h2 className={styles.groupTitle}>{group.title}</h2>
              {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
              <ul role="list" className={styles.list}>
                {group.links.map((link) => (
                  <li key={link.href}>
                    {link.render ? (
                      link.render({ className: styles.link ?? "", children: link.label })
                    ) : (
                      <a
                        href={link.href}
                        className={styles.link}
                        aria-current={link.current ? "page" : undefined}
                        {...(link.external
                          ? { target: "_blank", rel: "noopener noreferrer me" }
                          : {})}
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className={styles.disclosure}>
          <p>
            {affiliateNotice}{" "}
            <a href={affiliateLink.href} className={styles.disclosureLink}>
              {affiliateLink.label}
            </a>
          </p>
          <p>{priceDisclaimer}</p>
        </div>

        <div className={styles.bottom}>
          <p className={styles.copyright}>{copyrightLabel}</p>
          <div className={styles.legal}>
            {legalLinks.map((link) => (
              <a key={link.href} href={link.href} className={styles.link}>
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
      <p className={styles.wordmark} aria-hidden="true">
        {brandLabel}
      </p>
    </footer>
  );
}
