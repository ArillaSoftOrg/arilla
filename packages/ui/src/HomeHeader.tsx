"use client";

import { type CSSProperties, useEffect, useId, useState } from "react";
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
  /** Marka yazisinin yaninda gosterilecek küçük logo/isaret. */
  brandLogoSrc?: string;
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
  /** Oturum acik kullanici icin hesap linkinde gosterilecek profil fotografi. */
  accountAvatarUrl?: string | null;
  /** Fotograf yoksa avatar icindeki kisa etiket. */
  accountAvatarLabel?: string;
  /**
   * Istege bagli ikincil, sade baglanti (orn. lansman oncesi "Admin
   * Girişi"). Birincil eylem degildir: masaustunde hesap dugmesinin solunda
   * duz metin, telefonda menu panelinde.
   */
  utilityLink?: { label: string; href: string };
  /**
   * `chat`: sohbet calisma alani. Cubukta yalnizca menu dugmesi + marka kalir
   * (nav, hesap, yardimci link hamburger panelinde); cubuk yapiskandir ve
   * kaydirilinca ~%20 kuculur. Varsayilan `site` davranisi degismez.
   */
  variant?: "site" | "chat";
}

/** Kompakt moda gecis ve donus esikleri (px); aradaki fark titremeyi onler. */
const COMPACT_ENTER_Y = 24;
const COMPACT_EXIT_Y = 8;

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
  brandLogoSrc,
  navItems,
  navAriaLabel,
  accountHref,
  accountLabel,
  loginHref,
  loginLabel,
  accountCurrent = false,
  accountAvatarUrl,
  accountAvatarLabel,
  utilityLink,
  variant = "site",
}: HomeHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const menuId = useId();
  const accountText = accountHref ? accountLabel : loginLabel;
  const accountUrl = accountHref ?? loginHref;
  const mobileMenuTabIndex = menuOpen ? undefined : -1;
  const hasSignedInAccount = accountHref !== null;
  const avatarFallback = (accountAvatarLabel?.trim().charAt(0) || accountText.charAt(0) || "M")
    .toLocaleUpperCase("tr-TR")
    .slice(0, 1);
  const brandLogoStyle = brandLogoSrc
    ? ({ backgroundImage: `url(${JSON.stringify(brandLogoSrc)})` } satisfies CSSProperties)
    : undefined;
  const accountAvatarStyle = accountAvatarUrl
    ? ({ backgroundImage: `url(${JSON.stringify(accountAvatarUrl)})` } satisfies CSSProperties)
    : undefined;

  // Yalnizca sohbet varyanti: durum esige bagli (yone degil); state yalnizca
  // deger degisince guncellenir, olay pasif ve kare basina bir kez islenir.
  useEffect(() => {
    if (variant !== "chat") return;
    let frame = 0;
    function update() {
      frame = 0;
      const y = window.scrollY;
      setCompact((was) => (was ? y > COMPACT_EXIT_Y : y > COMPACT_ENTER_Y));
    }
    function onScroll() {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    }
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [variant]);

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
    <header
      className={styles.header}
      data-variant={variant}
      data-compact={variant === "chat" && compact ? "true" : undefined}
    >
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
          {brandLogoSrc ? (
            <span className={styles.brandLogo} style={brandLogoStyle} aria-hidden="true" />
          ) : null}
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

        {utilityLink ? (
          <a href={utilityLink.href} className={styles.utility}>
            {utilityLink.label}
          </a>
        ) : null}

        <a
          href={accountUrl}
          className={hasSignedInAccount ? styles.accountAvatar : styles.account}
          aria-current={accountCurrent ? "page" : undefined}
          aria-label={hasSignedInAccount ? accountText : undefined}
        >
          {hasSignedInAccount ? (
            <span className={styles.accountAvatarImage} style={accountAvatarStyle}>
              {accountAvatarUrl ? null : avatarFallback}
            </span>
          ) : (
            accountText
          )}
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
              {brandLogoSrc ? (
                <span
                  className={styles.mobileBrandLogo}
                  style={brandLogoStyle}
                  aria-hidden="true"
                />
              ) : null}
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
              {hasSignedInAccount ? (
                <span className={styles.mobileAccountContent}>
                  <span className={styles.mobileAccountAvatar} style={accountAvatarStyle}>
                    {accountAvatarUrl ? null : avatarFallback}
                  </span>
                  <span>{accountText}</span>
                </span>
              ) : (
                accountText
              )}
            </a>
            {utilityLink ? (
              <a
                href={utilityLink.href}
                className={styles.mobileUtilityLink}
                tabIndex={mobileMenuTabIndex}
                onClick={() => setMenuOpen(false)}
              >
                {utilityLink.label}
              </a>
            ) : null}
          </nav>
        </aside>
      </div>
    </header>
  );
}
