import { Container } from "./Container.tsx";
import styles from "./HomeHeader.module.css";

export interface HomeHeaderNavItem {
  label: string;
  href: string;
  /**
   * Bu oge su anki sayfaysa `true` - `aria-current="page"` ve gorsel etkin
   * durum. Cagiran taraf hesaplar (bilesen istemci JS'i veya URL okumaz);
   * verilmezse oge etkin sayilmaz.
   */
  current?: boolean;
}

export interface HomeHeaderProps {
  brandLabel: string;
  brandHref?: string;
  /** Yalnizca gercek bir route/anchor'i olan ogeler - dead link uretilmez, filtreleme cagiran tarafta yapilir. */
  navItems: readonly HomeHeaderNavItem[];
  navAriaLabel: string;
  /** null ise oturum yok, "Giris yap" gosterilir. */
  accountHref: string | null;
  accountLabel: string;
  loginHref: string;
  loginLabel: string;
  /** Hesap/giris linki su anki sayfaysa `true` (orn. `/giris`). */
  accountCurrent?: boolean;
}

/**
 * docs/pages.md "/": "Logo + üst çubuk". Sol wordmark, orta/sol nav, sag
 * auth durumu. Framework-agnostik duz `<a>` - ProductCard ile ayni desen.
 * Public site kabugunun (ana sayfa + public alt sayfalar) ortak ust cubugu.
 *
 * Faz 1B duzeni korunur: 640px altinda iki satir (wordmark + hesap, altta
 * gezinme), 640px ve ustunde tek satir. Hamburger yok, JS yok.
 */
export function HomeHeader({
  brandLabel,
  brandHref = "/",
  navItems,
  navAriaLabel,
  accountHref,
  accountLabel,
  loginHref,
  loginLabel,
  accountCurrent = false,
}: HomeHeaderProps) {
  return (
    <header className={styles.header}>
      <Container size="wide" className={styles.inner}>
        <a href={brandHref} className={styles.brand}>
          {brandLabel}
        </a>

        {navItems.length > 0 ? (
          <nav aria-label={navAriaLabel} className={styles.nav}>
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={styles.navLink}
                aria-current={item.current ? "page" : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
        ) : null}

        <a
          href={accountHref ?? loginHref}
          className={styles.account}
          aria-current={accountCurrent ? "page" : undefined}
        >
          {accountHref ? accountLabel : loginLabel}
        </a>
      </Container>
    </header>
  );
}
