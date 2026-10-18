"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import styles from "./products.module.css";

/**
 * Ürün listesi istemci parçaları. Sayfa sunucuda çizilir; burada yalnızca
 * gezinme (filtre → adres), bekleme durumu ve sağ panelin klavye davranışı var.
 * JavaScript yoksa form düz GET ile çalışır, panel bağlantıları normal sayfa
 * gezinmesidir: hiçbir akış tarayıcı deposuna dayanmaz.
 */

const PATH = "/yonetim/katalog/urunler";
const SEARCH_DEBOUNCE_MS = 400;

type Navigate = (href: string, options?: { scroll?: boolean }) => void;

const ListContext = createContext<{ navigate: Navigate; pending: boolean }>({
  navigate: () => {},
  pending: false,
});

/** Liste kabuğu: filtre formu ile sonuç bölgesi aynı geçişi (`useTransition`) paylaşır. */
export function ProductListShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback<Navigate>(
    (href, options) => {
      startTransition(() => router.push(href, { scroll: options?.scroll ?? false }));
    },
    [router],
  );
  return <ListContext.Provider value={{ navigate, pending }}>{children}</ListContext.Provider>;
}

/** Sonuç bölgesi: yeni sayfa gelirken eski satırlar soluklaşır ve `aria-busy` olur. */
export function PendingRegion({ children, label }: { children: ReactNode; label: string }) {
  const { pending } = useContext(ListContext);
  return (
    <section className={styles.results} aria-label={label} aria-busy={pending}>
      {pending ? (
        <p className={styles.pendingNote} role="status">
          Yükleniyor…
        </p>
      ) : null}
      <div className={pending ? styles.resultsBodyPending : styles.resultsBody}>{children}</div>
    </section>
  );
}

/** Form değerleri → temiz adres: boş ve varsayılan (`durum=published`) değerler yazılmaz. */
export function hrefFromForm(form: HTMLFormElement): string {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    const text = String(value).trim();
    if (!text) continue;
    if (key === "durum" && text === "published") continue;
    params.set(key, text);
  }
  const qs = params.toString();
  return qs ? `${PATH}?${qs}` : PATH;
}

/**
 * Filtre formu. Seçim değişince hemen, arama kutusunda yazmayı bırakınca
 * (400 ms) uygulanır; Enter ve "Uygula" düğmesi de çalışır. Her uygulamada
 * imleç ve açık panel düşer (yeni sonuç kümesi ilk sayfadan başlar).
 */
export function ProductFilterForm({
  children,
  activeCount,
  values,
}: {
  children: ReactNode;
  activeCount: number;
  /** Adresteki doğrulanmış değerler; dışarıdan değişince (etiket kaldırma, geri tuşu) alanlar eşitlenir. */
  values: Record<string, string | undefined>;
}) {
  const { navigate } = useContext(ListContext);
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Alanlar kontrolsüzdür (JS'siz GET de çalışsın): adres başka yoldan değişince
  // değerler buradan eşitlenir. Kullanıcının o an yazdığı alana dokunulmaz.
  const valuesKey = JSON.stringify(values);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const current = JSON.parse(valuesKey) as Record<string, string | undefined>;
    for (const element of Array.from(form.elements)) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) continue;
      if (!element.name || element.type === "hidden" || element === document.activeElement)
        continue;
      const fallback = element.name === "durum" ? "published" : "";
      element.value = current[element.name] ?? fallback;
    }
  }, [valuesKey]);

  const apply = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (formRef.current) navigate(hrefFromForm(formRef.current));
  }, [navigate]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply();
  };

  const onChange = (event: FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLSelectElement) {
      apply();
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "search") {
      const value = target.value.trim();
      if (timer.current) clearTimeout(timer.current);
      // 1 karakterlik başlık araması anlamsız ve pahalıdır; kimlik (rakam) hariç.
      if (value.length === 1 && !/^\d$/.test(value)) return;
      timer.current = setTimeout(apply, SEARCH_DEBOUNCE_MS);
    }
  };

  return (
    <form
      ref={formRef}
      action={PATH}
      method="get"
      className={styles.filterForm}
      aria-label="Ürün filtreleri"
      onSubmit={onSubmit}
      onChange={onChange}
    >
      <button
        type="button"
        className={styles.filterToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        {activeCount > 0 ? `Filtreler (${activeCount})` : "Filtreler"}
      </button>
      <div id={bodyId} className={open ? styles.filterBodyOpen : styles.filterBody}>
        {children}
      </div>
    </form>
  );
}

/**
 * Sağ panel (ürün ayrıntısı). Kipsiz: tablo kullanılabilir kalır. Açılınca
 * odak panel başlığına gider; Esc ya da "Kapat" paneli kapatır ve odak açan
 * satır bağlantısına döner. Dar ekranda tam genişlik, örtü tıklaması kapatır.
 */
export function ProductDrawer({
  closeHref,
  productId,
  titleId,
  children,
}: {
  closeHref: string;
  productId: number;
  titleId: string;
  children: ReactNode;
}) {
  const { navigate } = useContext(ListContext);
  const panelRef = useRef<HTMLElement>(null);

  const close = useCallback(() => {
    navigate(closeHref);
    // Odak, paneli açan satır bağlantısına döner (varsa).
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-product-link="${productId}"]`)?.focus();
    });
  }, [closeHref, navigate, productId]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>(`#${CSS.escape(titleId)}`)?.focus();
  }, [titleId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Açık bir yerel <dialog> varsa Esc onundur.
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <>
      <Link
        href={closeHref}
        scroll={false}
        className={styles.drawerBackdrop}
        aria-hidden="true"
        tabIndex={-1}
        onClick={(event) => {
          event.preventDefault();
          close();
        }}
      />
      <aside ref={panelRef} className={styles.drawer} role="dialog" aria-labelledby={titleId}>
        <div className={styles.drawerTop}>
          <span className={styles.drawerEyebrow}>{`Ürün #${productId}`}</span>
          <Link
            href={closeHref}
            scroll={false}
            className={styles.drawerClose}
            onClick={(event) => {
              event.preventDefault();
              close();
            }}
          >
            Kapat
            <span className={styles.kbd} aria-hidden="true">
              Esc
            </span>
          </Link>
        </div>
        <div className={styles.drawerBody}>{children}</div>
      </aside>
    </>
  );
}

/** Satırdaki ürün bağlantısı: paneli istemci gezinmesiyle açar (kaydırma korunur). */
export function ProductRowLink({
  href,
  productId,
  className,
  children,
  title,
}: {
  href: string;
  productId: number;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  const { navigate } = useContext(ListContext);
  return (
    <Link
      href={href}
      scroll={false}
      className={className}
      data-product-link={productId}
      title={title}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </Link>
  );
}
