"use client";

import { Button, CloseIcon } from "@arilla/ui";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./admin.module.css";
import { activeNavHref } from "./admin-nav.ts";

export interface AdminNavLink {
  href: string;
  label: string;
  description?: string;
}

export interface AdminNavSection {
  label: string;
  items: AdminNavLink[];
}

function hrefsOf(sections: AdminNavSection[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.href));
}

/**
 * Gezinme sürerken tıklanan bağlantının yanında sabit boyutlu nokta (düzen
 * kaymaz). Yönetim sayfaları dinamiktir ve rota düzeyi `loading.tsx` yoktur
 * (yetkisiz isteğin 404 durumu korunur, karar 0083); geri bildirim buradan.
 */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={pending ? `${styles.navPending} ${styles.navPendingOn}` : styles.navPending}
    />
  );
}

function NavItemLink({ item, active }: { item: AdminNavLink; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
      aria-current={active ? "page" : undefined}
    >
      {/* Açıklama: masaüstünde ekran okuyucuya, çekmecede (dokunmatik) görünür metin.
          `title` kullanılmaz: dokunmatikte ve klavyede görünmez. */}
      <span className={styles.navText}>
        <span>{item.label}</span>
        {item.description ? <span className={styles.navDesc}>{item.description}</span> : null}
      </span>
      <PendingHint />
    </Link>
  );
}

/**
 * Yan menü (docs/decisions/0083). Liste sunucuda yetkiye göre süzülür
 * (layout); bu bileşen yalnızca etkin bağlantıyı işaretler (en özel eşleşme,
 * `activeNavHref`) ve grupları katlar. Gruplar yerel `<details>`: klavye ve
 * ekran okuyucu desteği tarayıcıdan. Varsayılan: yalnızca etkin sayfanın
 * grubu açık (karar 0084), diğerleri kapalı ve elle açılıp kapanır.
 * Katlama durumu saklanmaz (tarayıcı deposu yok); oturum içinde layout
 * yeniden çizilmediği için gezinmede korunur.
 */
export function AdminNavClient({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();
  const activeHref = activeNavHref(hrefsOf(sections), pathname);
  return (
    <nav aria-label="Yönetim" className={styles.navSections}>
      {sections.map((section) => {
        const only = section.items.length === 1 ? section.items[0] : undefined;
        // Tek öğeli ve aynı adlı grup (Genel bakış): başlıksız düz bağlantı.
        if (only && only.label === section.label) {
          return (
            <div key={section.label} className={styles.navSection}>
              <ul className={styles.navList}>
                <li>
                  <NavItemLink item={only} active={only.href === activeHref} />
                </li>
              </ul>
            </div>
          );
        }
        return (
          <NavGroup
            key={section.label}
            section={section}
            activeHref={activeHref}
            containsActive={section.items.some((item) => item.href === activeHref)}
          />
        );
      })}
    </nav>
  );
}

function NavGroup({
  section,
  activeHref,
  containsActive,
}: {
  section: AdminNavSection;
  activeHref: string | null;
  containsActive: boolean;
}) {
  const [open, setOpen] = useState(containsActive);
  // Bu gruptaki bir sayfaya gidildiğinde grup kapalıysa açılır; elle açılan
  // diğer gruplar açık kalır.
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  return (
    <details
      className={styles.navSection}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className={
          containsActive ? `${styles.navHeading} ${styles.navHeadingCurrent}` : styles.navHeading
        }
      >
        <span>{section.label}</span>
        {!open ? <span className={styles.navCount}>{section.items.length}</span> : null}
        <span className={styles.navChevron} aria-hidden="true" />
      </summary>
      <ul className={styles.navList}>
        {section.items.map((item) => (
          <li key={item.href}>
            <NavItemLink item={item} active={item.href === activeHref} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Etkin sayfanın adı (dar ekran üst çubuğu için). */
function activeLabel(sections: AdminNavSection[], pathname: string): string {
  const href = activeNavHref(hrefsOf(sections), pathname);
  for (const section of sections) {
    const item = section.items.find((i) => i.href === href);
    if (item) return pathname === item.href ? item.label : `${item.label} · ayrıntı`;
  }
  return "Yönetim";
}

/**
 * Dar ekran (< 1024px) menüsü: üst çubuktaki düğme yan menüyü yerel modal
 * `<dialog>` içinde açar. Odak tuzağı, Esc ve odak dönüşü tarayıcıdan;
 * gezinme ve "Menüyü kapat" düğmesi de kapatır. Örtüye tıklama bilerek
 * kapatmaz (design.md "LoginModal" ile aynı kural). Açıkken sayfa kaydırması
 * kilitlenir.
 */
export function AdminMobileNav({
  sections,
  brand,
  roleLabel,
}: {
  sections: AdminNavSection[];
  brand: string;
  roleLabel: string;
}) {
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const drawerId = useId();

  // Bir bağlantıya gidildiğinde çekmece kapanır.
  // biome-ignore lint/correctness/useExhaustiveDependencies: yalnızca adres değişimi tetikler.
  useEffect(() => {
    dialogRef.current?.close();
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      {/* Görünürlük sarmalayıcıda: Button kendi `display` kuralını taşır. */}
      <span className={styles.menuButton}>
        <Button
          type="button"
          variant="secondary"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => {
            dialogRef.current?.showModal();
            setOpen(true);
          }}
        >
          Menü
        </Button>
      </span>
      <span className={styles.topbarTitle}>{activeLabel(sections, pathname)}</span>
      <dialog
        ref={dialogRef}
        id={drawerId}
        className={styles.drawer}
        aria-label="Yönetim menüsü"
        onClose={() => setOpen(false)}
      >
        <div className={styles.brand}>
          <span className={styles.brandLink}>
            {/* biome-ignore lint/performance/noImgElement: 32px uygulama ikonu (Next metadata rotası, 180px PNG); optimizasyon gerekmez. */}
            <img src="/apple-icon.png" alt="" className={styles.brandMark} width={32} height={32} />
            <span className={styles.brandTitle}>
              {brand}
              <span className={styles.brandSub}>{`Yönetim konsolu · ${roleLabel}`}</span>
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            aria-label="Menüyü kapat"
            onClick={() => dialogRef.current?.close()}
          >
            <CloseIcon size={18} />
          </Button>
        </div>
        <div className={styles.sidebarScroll}>
          <AdminNavClient sections={sections} />
        </div>
        <div className={styles.sidebarFooter}>
          <a href="/" className={styles.navLink}>
            Siteye dön
          </a>
        </div>
      </dialog>
    </>
  );
}

/**
 * Konum yolu: Yönetim / grup / sayfa (/ Ayrıntı). Menüyle aynı (yetkiye göre
 * süzülmüş) listeden türetilir; adres bir menü öğesinin alt sayfasıysa son
 * halka "Ayrıntı" olur. Genel bakışta gösterilmez.
 */
export function AdminBreadcrumbs({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();
  const activeHref = activeNavHref(hrefsOf(sections), pathname);
  if (!activeHref) return null;
  if (activeHref === "/yonetim") {
    // Genel bakışta da üst çubuk boş kalmaz: tek halkalı konum.
    return (
      <nav aria-label="Konum" className={`${styles.breadcrumbs} ${styles.breadcrumbsInTopbar}`}>
        <ol className={styles.breadcrumbList}>
          <li>
            <span aria-current="page">Yönetim</span>
          </li>
        </ol>
        <p className={styles.breadcrumbNote}>Şimdi dikkat isteyenler ve temel sayılar.</p>
      </nav>
    );
  }
  const section = sections.find((s) => s.items.some((item) => item.href === activeHref));
  const item = section?.items.find((i) => i.href === activeHref);
  if (!section || !item) return null;
  const isDetail = pathname !== activeHref;
  return (
    <nav aria-label="Konum" className={`${styles.breadcrumbs} ${styles.breadcrumbsInTopbar}`}>
      <ol className={styles.breadcrumbList}>
        <li>
          <Link href="/yonetim">Yönetim</Link>
        </li>
        <li>{section.label}</li>
        <li>
          {isDetail ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </li>
        {isDetail ? (
          <li>
            <span aria-current="page">Ayrıntı</span>
          </li>
        ) : null}
      </ol>
      {!isDetail && item.description ? (
        <p className={styles.breadcrumbNote}>{item.description}</p>
      ) : null}
    </nav>
  );
}
