"use client";

import { useEffect, useId, useState } from "react";
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
 * Faz 1B duzeni korunur: 640px altinda ana nav gizlenir; hamburger dugmesi
 * ayni linkleri soldan acilan mobil panelde sunar.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const accountText = accountHref ? accountLabel : loginLabel;
  const accountUrl = accountHref ?? loginHref;
  const mobileMenuTabIndex = menuOpen ? undefined : -1;

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  return (
    <header className={styles.header}>
      <Container size="wide" className={styles.inner}>
        <button
          type="button"
          className={styles.menuButton}
          aria-label={menuOpen ? "Menüyü kapat" : "Menüyü aç"}
          aria-controls={menuId}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((isOpen) => !isOpen)}
        >
          <span className={styles.menuIcon} aria-hidden="true" />
        </button>

        <a href={brandHref} className={styles.brand}>
          <span className={styles.brandText}>{brandLabel}</span>
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
          href={accountUrl}
          className={styles.account}
          aria-current={accountCurrent ? "page" : undefined}
        >
          {accountText}
        </a>
      </Container>

      <div className={styles.mobileMenuLayer} data-open={menuOpen ? "true" : "false"}>
        <button
          type="button"
          className={styles.mobileMenuScrim}
          aria-label="Menüyü kapat"
          tabIndex={menuOpen ? 0 : -1}
          onClick={() => setMenuOpen(false)}
        />
        <aside
          id={menuId}
          className={styles.mobileMenu}
          aria-label={navAriaLabel}
          aria-hidden={!menuOpen}
        >
          <div className={styles.mobileMenuHeader}>
            <a
              href={brandHref}
              className={styles.mobileBrand}
              tabIndex={mobileMenuTabIndex}
              onClick={() => setMenuOpen(false)}
            >
              {brandLabel}
            </a>
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Menüyü kapat"
              tabIndex={mobileMenuTabIndex}
              onClick={() => setMenuOpen(false)}
            >
              <span aria-hidden="true">x</span>
            </button>
          </div>

          <nav className={styles.mobileNav} aria-label={navAriaLabel}>
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={styles.mobileNavLink}
                aria-current={item.current ? "page" : undefined}
                tabIndex={mobileMenuTabIndex}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </a>
            ))}
            <a
              href={accountUrl}
              className={styles.mobileAccountLink}
              aria-current={accountCurrent ? "page" : undefined}
              tabIndex={mobileMenuTabIndex}
              onClick={() => setMenuOpen(false)}
            >
              {accountText}
            </a>
          </nav>
        </aside>
      </div>
    </header>
  );
}
