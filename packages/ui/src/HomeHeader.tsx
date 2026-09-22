import styles from "./HomeHeader.module.css";

export interface HomeHeaderNavItem {
  label: string;
  href: string;
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
}

/**
 * docs/pages.md "/": "Logo + üst çubuk". Sol wordmark, orta/sol nav, sag
 * auth durumu. Framework-agnostik duz `<a>` - ProductCard ile ayni desen.
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
}: HomeHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <a href={brandHref} className={styles.brand}>
          {brandLabel}
        </a>

        {navItems.length > 0 ? (
          <nav aria-label={navAriaLabel} className={styles.nav}>
            {navItems.map((item) => (
              <a key={item.href} href={item.href} className={styles.navLink}>
                {item.label}
              </a>
            ))}
          </nav>
        ) : null}

        <a href={accountHref ?? loginHref} className={styles.account}>
          {accountHref ? accountLabel : loginLabel}
        </a>
      </div>
    </header>
  );
}
