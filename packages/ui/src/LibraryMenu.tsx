"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatTRY } from "./format.ts";
import { CloseIcon, ImageIcon, SearchIcon } from "./icons.tsx";
import styles from "./LibraryMenu.module.css";

export interface LibraryMenuCopy {
  trigger: string;
  title: string;
  panelLabel: string;
  close: string;
  all: string;
  categoriesLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  loading: string;
  loadMore: string;
  remove: string;
  clear: string;
  empty: string;
  emptyFiltered: string;
  consentOff: string;
  consentLink: string;
  error: string;
  retry: string;
}

export interface LibraryMenuProps {
  copy: LibraryMenuCopy;
  /** `GET` ucu (oturumdan okur); varsayilan `/api/kutuphane`. */
  endpoint?: string;
  /** Rizayi acma sayfasi (bos durumda baglanti). */
  consentHref: string;
  /** Server action'lar: kullanici yalniz kendi satirini siler. */
  onRemove: (productId: number) => Promise<void>;
  onClear: () => Promise<void>;
}

interface LibraryRow {
  productId: number;
  slug: string;
  title: string;
  imageUrl: string | null;
  brand: string | null;
  minPrice: number | null;
}

interface LibraryResponse {
  consent: boolean;
  categories: { slug: string; name: string }[];
  nextCursor: string | null;
  items: LibraryRow[];
}

type Status = "idle" | "loading" | "error";

const FOCUSABLE = "a[href], button:not(:disabled), input, [tabindex]:not([tabindex='-1'])";

/**
 * Karar 0217: Kutuphane - aramalarda ilk 3'te cikan gercek urunlerin kisisel vitrini.
 * Masaustunde baslik cubugundan acilan panel, telefonda alttan acilan sayfa (CSS).
 * Veri menu ACILINCA cekilir (baslik her sayfada sorgu yapmaz). Urun adi, gorsel ve fiyat
 * sunucuda guncel katalogdan gelir; bu bilesen hicbir sey saklamaz.
 */
export function LibraryMenu({
  copy,
  endpoint = "/api/kutuphane",
  consentHref,
  onRemove,
  onClear,
}: LibraryMenuProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [categories, setCategories] = useState<{ slug: string; name: string }[]>([]);
  const [consent, setConsent] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [broken, setBroken] = useState<ReadonlySet<number>>(new Set());
  const panelId = useId();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (cursor: string | null) => {
      const request = ++requestRef.current;
      setStatus("loading");
      try {
        const params = new URLSearchParams();
        if (category) params.set("kategori", category);
        if (debounced) params.set("q", debounced);
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("status");
        const data = (await response.json()) as LibraryResponse;
        if (request !== requestRef.current) return;
        setRows((previous) => (cursor ? [...previous, ...data.items] : data.items));
        setCategories(data.categories);
        setConsent(data.consent);
        setNextCursor(data.nextCursor);
        setStatus("idle");
      } catch {
        if (request === requestRef.current) setStatus("error");
      }
    },
    [category, debounced, endpoint],
  );

  useEffect(() => {
    if (open) void load(null);
  }, [open, load]);

  // Odak: acilinca panele, kapaninca tetige; Escape, dis tiklama, Tab dongusu.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    const mobile = window.matchMedia("(max-width: 639.98px)");
    if (mobile.matches) document.body.style.overflow = "hidden";

    function close() {
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  async function remove(productId: number) {
    setRows((previous) => previous.filter((row) => row.productId !== productId));
    try {
      await onRemove(productId);
    } finally {
      void load(null);
    }
  }

  async function clearAll() {
    setRows([]);
    setCategories([]);
    setNextCursor(null);
    try {
      await onClear();
    } finally {
      void load(null);
    }
  }

  const filtered = category !== null || debounced !== "";
  const empty = status === "idle" && rows.length === 0;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <ImageIcon size={18} />
        <span className={styles.triggerLabel}>{copy.trigger}</span>
      </button>

      {open ? (
        <>
          <div className={styles.scrim} aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={styles.panel}
          >
            <div className={styles.head}>
              <h2 id={titleId} className={styles.title}>
                {copy.title}
              </h2>
              {rows.length > 0 && !filtered ? (
                <button type="button" className={styles.textButton} onClick={clearAll}>
                  {copy.clear}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.iconButton}
                aria-label={copy.close}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus({ preventScroll: true });
                }}
              >
                <CloseIcon size={20} />
              </button>
            </div>

            {categories.length > 0 ? (
              <fieldset className={styles.chips} aria-label={copy.categoriesLabel}>
                <button
                  type="button"
                  className={styles.chip}
                  aria-pressed={category === null}
                  onClick={() => setCategory(null)}
                >
                  {copy.all}
                </button>
                {categories.map((item) => (
                  <button
                    key={item.slug}
                    type="button"
                    className={styles.chip}
                    aria-pressed={category === item.slug}
                    onClick={() => setCategory(item.slug)}
                  >
                    {item.name}
                  </button>
                ))}
              </fieldset>
            ) : null}

            <div className={styles.body} aria-busy={status === "loading"}>
              {rows.length > 0 ? (
                // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur.
                <ul role="list" className={styles.list}>
                  {rows.map((row) => (
                    <li key={row.productId} className={styles.item}>
                      <a href={`/urun/${row.slug}`} className={styles.link}>
                        <span className={styles.thumb}>
                          {row.imageUrl && !broken.has(row.productId) ? (
                            <img
                              src={row.imageUrl}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              referrerPolicy="no-referrer"
                              onError={() => setBroken((prev) => new Set(prev).add(row.productId))}
                            />
                          ) : (
                            <ImageIcon size={20} className={styles.placeholder} />
                          )}
                        </span>
                        <span className={styles.copy}>
                          <span className={styles.name}>{row.title}</span>
                          <span className={styles.meta}>
                            {[row.brand, row.minPrice !== null ? formatTRY(row.minPrice) : null]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                      </a>
                      <button
                        type="button"
                        className={styles.removeButton}
                        aria-label={`${copy.remove}: ${row.title}`}
                        onClick={() => remove(row.productId)}
                      >
                        <CloseIcon size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {status === "loading" && rows.length === 0 ? (
                <p className={styles.note} role="status">
                  {copy.loading}
                </p>
              ) : null}
              {status === "error" ? (
                <p className={styles.note} role="alert">
                  {copy.error}{" "}
                  <button type="button" className={styles.textButton} onClick={() => load(null)}>
                    {copy.retry}
                  </button>
                </p>
              ) : null}
              {empty ? (
                <p className={styles.note}>
                  {filtered ? copy.emptyFiltered : consent ? copy.empty : copy.consentOff}{" "}
                  {!filtered && !consent ? (
                    <a href={consentHref} className={styles.noteLink}>
                      {copy.consentLink}
                    </a>
                  ) : null}
                </p>
              ) : null}
              {nextCursor && status !== "loading" ? (
                <button type="button" className={styles.loadMore} onClick={() => load(nextCursor)}>
                  {copy.loadMore}
                </button>
              ) : null}
            </div>

            <div className={styles.foot}>
              <label className={styles.search}>
                <SearchIcon size={18} />
                <span className={styles.srOnly}>{copy.searchLabel}</span>
                <input
                  type="search"
                  value={query}
                  maxLength={80}
                  placeholder={copy.searchPlaceholder}
                  autoComplete="off"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
