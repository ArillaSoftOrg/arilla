import type { CSSProperties, ReactNode } from "react";
import { Container } from "./Container.tsx";
import styles from "./SiteFooter.module.css";

export interface FooterLink {
  label: string;
  href: string;
  /** Bu link su anki sayfaysa `true` - `aria-current="page"`. Cagiran hesaplar. */
  current?: boolean;
  /** Dis site linki (orn. resmi sosyal hesap): yeni sekmede, `noopener noreferrer me`. */
  external?: boolean;
  /**
   * Karar 0038: duz `<a>` yerine baska bir oge (orn. "Cerez Tercihleri"
   * paneli acan istemci dugmesi). Footer link sinifini alir, gorunum ayni
   * kalir; JS yoksa ogenin kendisi `href`'e dusmeyi saglar.
   */
  render?: (props: { className: string; children: ReactNode }) => ReactNode;
}

export interface FooterGroup {
  title: string;
  links: readonly FooterLink[];
}

export interface FooterSocialLink {
  label: string;
  href: string;
  icon: ReactNode;
}

export interface FooterSocialGroup {
  title: string;
  links: readonly FooterSocialLink[];
}

export interface SiteFooterProps {
  brandLabel: string;
  brandDescription: string;
  /** Wordmark'in linki; varsayilan `/`. */
  brandHref?: string;
  /** Header ile ayni uygulama isareti. */
  brandLogoSrc?: string;
  groups: readonly FooterGroup[];
  /** Dogrulanmis sosyal hesaplar; metin listesi yerine ikon baglantilari olarak gosterilir. */
  socialGroup?: FooterSocialGroup;
  /**
   * Verilirse disclosure bandinda affiliate notu. Karar 0093 revizyonu: public
   * site footer'i bunu artik gostermez (bildirim urun sayfasinda, magaza
   * baglantisinin yanindadir); bilesen secenegi korur.
   */
  affiliateNotice?: string;
  /** Verilirse affiliate notunun ardindan ayrintili aciklamaya link. */
  affiliateLink?: { label: string; href: string };
  priceDisclaimer: string;
  copyrightLabel: string;
  /** Zemindeki buyuk dekoratif kelime isareti; varsayilan `brandLabel`. */
  decorativeWordmark?: string;
  /** Page-specific visual treatment; does not change other public footers. */
  variant?: "default" | "prelaunch";
}

/**
 * docs/pages.md "/" Faz 5: gercek, tamamlanmis footer. `groups` yalnizca
 * gercekten var olan route'lari icerir - cagiran taraf (page.tsx) bunu
 * saglar, bilesen kendisi route uydurmaz. Affiliate/fiyat-stok metinleri
 * `legal.*` (docs/copy.md) ile AYNI - homepage'te baska yerde tekrarlanmaz.
 *
 * Hiyerarsi: marka blogu -> link gruplari (Urun, Hesap, Yasal) ->
 * disclosure bandi (affiliate + fiyat/stok) -> telif satiri.
 *
 * Footer header'daki marka kilidini tekrarlar: uygulama isareti, marka adi,
 * kisa aciklama ve gercek sayfa baglantilari. Alt bant yalnizca yasal bilgi
 * ve telif satirini tasir.
 */
export function SiteFooter({
  brandLabel,
  brandDescription,
  brandHref = "/",
  brandLogoSrc,
  groups,
  socialGroup,
  affiliateNotice,
  affiliateLink,
  priceDisclaimer,
  copyrightLabel,
  decorativeWordmark = brandLabel,
  variant = "default",
}: SiteFooterProps) {
  const brandLogoStyle = brandLogoSrc
    ? ({ backgroundImage: `url(${JSON.stringify(brandLogoSrc)})` } satisfies CSSProperties)
    : undefined;

  return (
    <footer className={styles.footer} data-variant={variant}>
      <Container size="wide" className={styles.inner}>
        <div
          className={styles.top}
          data-has-social={socialGroup?.links.length ? "true" : undefined}
        >
          <div className={styles.brand}>
            <a href={brandHref} className={styles.brandLabel}>
              {brandLogoSrc ? (
                <span className={styles.brandLogo} style={brandLogoStyle} aria-hidden="true" />
              ) : null}
              <span>{brandLabel}</span>
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
          {socialGroup?.links.length ? (
            <nav aria-label={socialGroup.title} className={styles.socialGroup}>
              <h2 className={styles.groupTitle}>{socialGroup.title}</h2>
              {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
              <ul role="list" className={styles.socialList}>
                {socialGroup.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className={styles.socialLink}
                      target="_blank"
                      rel="noopener noreferrer me"
                      aria-label={link.label}
                      title={link.label}
                    >
                      {link.icon}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>

        <div className={styles.disclosure}>
          {affiliateNotice ? (
            <p className={styles.disclosureText}>
              {affiliateNotice}
              {affiliateLink ? (
                <>
                  {" "}
                  <a href={affiliateLink.href} className={styles.disclosureLink}>
                    {affiliateLink.label}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          <p className={styles.disclosureText}>{priceDisclaimer}</p>
        </div>

        <p className={styles.copyright}>{copyrightLabel}</p>
      </Container>
      <div className={styles.wordmarkArea} aria-hidden="true">
        <span className={styles.wordmark}>{decorativeWordmark}</span>
      </div>
    </footer>
  );
}
