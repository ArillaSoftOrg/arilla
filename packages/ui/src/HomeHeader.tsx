"use client";

import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Container } from "./Container.tsx";
import styles from "./HomeHeader.module.css";
import { ChevronRightIcon, CloseIcon, LogoutIcon } from "./icons.tsx";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

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
  /** Birincil hesap/giris eylemini dar mobil cubukta gizler; menu panelinde tutar. */
  accountInMobileMenuOnly?: boolean;
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
   * Karar 0092: tema kontrolu (cagiran saglar; tercih/kalicilik apps/web'de).
   * 640px ve ustunde cubukta hesap alaninin solunda (sohbet varyantinda da);
   * altinda cubuk yalin kalir, kontrol menu panelinde bir satirdir. Iki ornek
   * ayni durumu okur.
   */
  themeControl?: ReactNode;
  /** Paneldeki tema satirinin gorunur etiketi (dugmenin kendi adi zaten var). */
  themeControlLabel?: string;
  /**
   * `chat`: sohbet calisma alani. Cubukta yalnizca menu dugmesi + marka kalir
   * (nav, hesap, yardimci link hamburger panelinde); cubuk yapiskandir ve
   * kaydirilinca ~%20 kuculur. Varsayilan `site` davranisi degismez.
   */
  variant?: "site" | "chat";
  /**
   * Menu panelinin kisisel bolumu (orn. Kaydettiklerim, Alarmlarım,
   * Geçmişim). Yalnizca oturumu acik ve urune erisebilen kullanici icin
   * verilir; cagiran filtreler. Bos/verilmezse bolum cizilmez.
   */
  personalNavItems?: readonly HomeHeaderNavItem[];
  /** Kisisel bolumun basligi ve `nav` etiketi. */
  personalNavLabel?: string;
  /** Panelin alt hesap alaninda gorunen ad (yoksa e-posta, yoksa `accountLabel`). */
  accountName?: string | null;
  /** Hesap alaninda adin altindaki ikincil satir. */
  accountEmail?: string | null;
  /**
   * Verilirse hesap alaninda kucuk "Çıkış" dugmesi: mevcut cikis server
   * action'i (duz form POST; JS'siz de calisir).
   */
  logoutAction?: () => void | Promise<void>;
  logoutLabel?: string;
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
  accountInMobileMenuOnly = false,
  accountCurrent = false,
  accountAvatarUrl,
  accountAvatarLabel,
  themeControl,
  themeControlLabel,
  utilityLink,
  variant = "site",
  personalNavItems = [],
  personalNavLabel,
  accountName,
  accountEmail,
  logoutAction,
  logoutLabel,
}: HomeHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const accountText = accountHref ? accountLabel : loginLabel;
  const accountUrl = accountHref ?? loginHref;
  const mobileMenuTabIndex = menuOpen ? undefined : -1;
  const hasSignedInAccount = accountHref !== null;
  const drawerName = accountName?.trim() || accountEmail?.trim() || accountLabel;
  const drawerEmail =
    accountEmail?.trim() && accountEmail.trim() !== drawerName ? accountEmail : null;
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

  // Panel acilinca odak kapat dugmesine, kapaninca menu dugmesine doner.
  useEffect(() => {
    if (menuOpen) {
      wasOpenRef.current = true;
      closeButtonRef.current?.focus({ preventScroll: true });
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      menuButtonRef.current?.focus({ preventScroll: true });
    }
  }, [menuOpen]);

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
          ref={menuButtonRef}
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

        {themeControl ? <div className={styles.themeSlot}>{themeControl}</div> : null}

        {utilityLink ? (
          <a href={utilityLink.href} className={styles.utility}>
            {utilityLink.label}
          </a>
        ) : null}

        <a
          href={accountUrl}
          className={hasSignedInAccount ? styles.accountAvatar : styles.account}
          data-mobile-menu-only={accountInMobileMenuOnly ? "true" : undefined}
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
        {/* Karar: panel uc bolge - ust (marka + kapat), kaydirilabilir govde
            (gezinme, kisisel bolum, yardimci link, tema) ve altta sabit hesap
            alani. Kapaliyken `inert`: odak ve ekran okuyucu disarida. */}
        <aside
          id={menuId}
          className={styles.mobileMenu}
          aria-label={navAriaLabel}
          aria-hidden={!menuOpen}
          inert={!menuOpen}
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
              ref={closeButtonRef}
              type="button"
              className={styles.closeButton}
              aria-label="Menüyü kapat"
              tabIndex={mobileMenuTabIndex}
              onClick={() => setMenuOpen(false)}
            >
              <CloseIcon size={22} />
            </button>
          </div>

          <div className={styles.drawerBody}>
            {navItems.length > 0 ? (
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
              </nav>
            ) : null}

            {hasSignedInAccount && personalNavItems.length > 0 ? (
              <nav className={styles.personalNav} aria-label={personalNavLabel}>
                {personalNavLabel ? (
                  <p className={styles.personalTitle} aria-hidden="true">
                    {personalNavLabel}
                  </p>
                ) : null}
                {personalNavItems.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className={styles.personalLink}
                    aria-current={item.current ? "page" : undefined}
                    tabIndex={mobileMenuTabIndex}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.label}
                  </a>
                ))}
              </nav>
            ) : null}

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

            {themeControl ? (
              <div className={styles.mobileTheme}>
                {themeControlLabel ? (
                  <span className={styles.mobileThemeLabel} aria-hidden="true">
                    {themeControlLabel}
                  </span>
                ) : null}
                {themeControl}
              </div>
            ) : null}
          </div>

          <div className={styles.drawerAccount}>
            {hasSignedInAccount ? (
              <>
                <a
                  href={accountUrl}
                  className={styles.drawerAccountLink}
                  aria-current={accountCurrent ? "page" : undefined}
                  tabIndex={mobileMenuTabIndex}
                  onClick={() => setMenuOpen(false)}
                >
                  <span className={styles.drawerAccountAvatar} style={accountAvatarStyle}>
                    {accountAvatarUrl ? null : avatarFallback}
                  </span>
                  <span className={styles.drawerAccountText}>
                    <VisuallyHidden>{accountText}: </VisuallyHidden>
                    <span className={styles.drawerAccountName}>{drawerName}</span>
                    {drawerEmail ? (
                      <span className={styles.drawerAccountEmail}>{drawerEmail}</span>
                    ) : null}
                  </span>
                  <ChevronRightIcon size={18} className={styles.drawerAccountChevron} />
                </a>
                {logoutAction && logoutLabel ? (
                  <form action={logoutAction} className={styles.drawerLogoutForm}>
                    <button
                      type="submit"
                      className={styles.drawerLogout}
                      tabIndex={mobileMenuTabIndex}
                    >
                      <LogoutIcon size={16} />
                      {logoutLabel}
                    </button>
                  </form>
                ) : null}
              </>
            ) : (
              <a
                href={accountUrl}
                className={styles.drawerLogin}
                aria-current={accountCurrent ? "page" : undefined}
                tabIndex={mobileMenuTabIndex}
                onClick={() => setMenuOpen(false)}
              >
                {accountText}
              </a>
            )}
          </div>
        </aside>
      </div>
    </header>
  );
}
