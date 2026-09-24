import { Container } from "./Container.tsx";
import styles from "./SiteFooter.module.css";

export interface FooterLink {
  label: string;
  href: string;
  /** Bu link su anki sayfaysa `true` - `aria-current="page"`. Cagiran hesaplar. */
  current?: boolean;
}

export interface FooterGroup {
  title: string;
  links: readonly FooterLink[];
}

export interface SiteFooterProps {
  brandLabel: string;
  brandDescription: string;
  /** Wordmark'in linki; varsayilan `/`. */
  brandHref?: string;
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
 *
 * Hiyerarsi: marka blogu -> link gruplari (Urun, Hesap, Bilgi) ->
 * disclosure bandi (affiliate + fiyat/stok) -> telif satiri.
 */
export function SiteFooter({
  brandLabel,
  brandDescription,
  brandHref = "/",
  groups,
  affiliateNotice,
  priceDisclaimer,
  copyrightLabel,
}: SiteFooterProps) {
  return (
    <footer className={styles.footer}>
      <Container size="wide" className={styles.inner}>
        <div className={styles.top}>
          <div className={styles.brand}>
            <a href={brandHref} className={styles.brandLabel}>
              {brandLabel}
            </a>
            <p className={styles.brandDescription}>{brandDescription}</p>
          </div>
          <div className={styles.groups}>
            {groups.map((group) => (
              <nav key={group.title} aria-label={group.title} className={styles.group}>
                <h2 className={styles.groupTitle}>{group.title}</h2>
                {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
                <ul role="list" className={styles.linkList}>
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        className={styles.link}
                        aria-current={link.current ? "page" : undefined}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className={styles.disclosure}>
          <p className={styles.disclosureText}>{affiliateNotice}</p>
          <p className={styles.disclosureText}>{priceDisclaimer}</p>
        </div>

        <p className={styles.copyright}>{copyrightLabel}</p>
      </Container>
    </footer>
  );
}
