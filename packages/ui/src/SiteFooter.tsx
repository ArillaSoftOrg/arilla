import type { ReactNode } from "react";
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

export interface SiteFooterProps {
  brandLabel: string;
  brandDescription: string;
  /** Wordmark'in linki; varsayilan `/`. */
  brandHref?: string;
  groups: readonly FooterGroup[];
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
  /** Alttaki buyuk dekoratif kelime isareti; varsayilan `brandLabel`. */
  decorativeWordmark?: string;
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
 * Karar 0093: markali zemin - yumusak nane/limon atmosferi ve en altta,
 * kenarlardan kirpilmis buyuk "ManiCepte" kelime isareti (site fontuyla
 * yazilir, cizilmis logo degil). Kelime isareti metnin ALTINDAKI kendi
 * seridindedir, hicbir metinle ust uste binmez. Ikisi de yalnizca dekordur:
 * `aria-hidden`, tiklanmaz, zorla-renk ve baskida yok.
 */
export function SiteFooter({
  brandLabel,
  brandDescription,
  brandHref = "/",
  groups,
  affiliateNotice,
  affiliateLink,
  priceDisclaimer,
  copyrightLabel,
  decorativeWordmark = brandLabel,
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
      <div className={styles.wordmarkBand} aria-hidden="true">
        <span className={styles.wordmark}>{decorativeWordmark}</span>
      </div>
    </footer>
  );
}
