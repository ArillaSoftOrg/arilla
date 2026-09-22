import styles from "./SiteFooter.module.css";

export interface FooterLink {
  label: string;
  href: string;
}

export interface FooterGroup {
  title: string;
  links: readonly FooterLink[];
}

export interface SiteFooterProps {
  brandLabel: string;
  brandDescription: string;
  groups: readonly FooterGroup[];
  affiliateNotice: string;
  priceDisclaimer: string;
  copyrightLabel: string;
}

/**
 * docs/pages.md "/" Faz 5: gercek, tamamlanmis footer. `groups` yalnizca
 * gercekten var olan route'lari icerir - cagiran taraf (page.tsx) bunu
 * saglar, bilesen kendisi route uydurmaz. Affiliate/fiyat-stok metinleri
 * `legal.*` (docs/copy.md) ile AYNI - homepage'te baska yerde tekrarlanmaz.
 */
export function SiteFooter({
  brandLabel,
  brandDescription,
  groups,
  affiliateNotice,
  priceDisclaimer,
  copyrightLabel,
}: SiteFooterProps) {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.columns}>
          <div className={styles.brand}>
            <p className={styles.brandLabel}>{brandLabel}</p>
            <p className={styles.brandDescription}>{brandDescription}</p>
          </div>
          {groups.map((group) => (
            <nav key={group.title} aria-label={group.title} className={styles.group}>
              <h2 className={styles.groupTitle}>{group.title}</h2>
              <ul className={styles.linkList}>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} className={styles.link}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className={styles.disclosure}>
          <p className={styles.disclosureText}>{affiliateNotice}</p>
          <p className={styles.disclosureText}>{priceDisclaimer}</p>
          <p className={styles.copyright}>{copyrightLabel}</p>
        </div>
      </div>
    </footer>
  );
}
