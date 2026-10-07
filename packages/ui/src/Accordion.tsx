"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import styles from "./Accordion.module.css";
import { ChevronRightIcon } from "./icons.tsx";
import { joinClassNames } from "./layout.ts";

export interface AccordionItem {
  /**
   * Kalıcı kimlik: öğe kapsayıcısının `id`'si olur, `#kimlik` çapasıyla açılır
   * (ör. `/sss#fiyat-guncelligi`). Sayfada tekil olmalıdır.
   */
  id: string;
  heading: string;
  content: ReactNode;
}

export interface AccordionProps {
  items: readonly AccordionItem[];
  /** Başlık düzeyi; sayfa `<h1>` içeriyorsa `2`. */
  headingLevel?: 2 | 3;
  className?: string;
}

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/**
 * WAI-ARIA akordeon deseni (APG "Accordion"): başlık içinde gerçek
 * `<button>` (`aria-expanded`, `aria-controls`); panel düğmeyle etiketli
 * `<section>` (örtük `region` rolü). Enter/Boşluk düğmenin kendisi; Yukarı/Aşağı/Home/End
 * başlıklar arasında gezer. Birden fazla öğe aynı anda açık kalabilir.
 *
 * Kapalı panel `hidden` ile gizlenir ama sunucu çıktısında YER ALIR: içerik
 * arama motorlarına ve sayfa içi bağlantılara görünür. URL çapası (`#kimlik`)
 * ilgili öğeyi açar ve ona kaydırır.
 */
export function Accordion({ items, headingLevel = 2, className }: AccordionProps) {
  const baseId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const Heading = `h${headingLevel}` as const;

  const openFromHash = useCallback(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id || !items.some((item) => item.id === id)) return;
    setOpen((current) => new Set(current).add(id));
    buttons.current.get(id)?.focus({ preventScroll: true });
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [items]);

  useEffect(() => {
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [openFromHash]);

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onHeaderKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!NAVIGATION_KEYS.has(event.key)) return;
    event.preventDefault();
    const last = items.length - 1;
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? index === last
              ? 0
              : index + 1
            : index === 0
              ? last
              : index - 1;
    const id = items[target]?.id;
    if (id) buttons.current.get(id)?.focus();
  }

  return (
    <div className={joinClassNames(styles.accordion, className)}>
      {items.map((item, index) => {
        const expanded = open.has(item.id);
        const buttonId = `${baseId}-${item.id}-button`;
        const panelId = `${baseId}-${item.id}-panel`;
        return (
          <div key={item.id} id={item.id} className={styles.item}>
            <Heading className={styles.heading}>
              <button
                ref={(node) => {
                  if (node) buttons.current.set(item.id, node);
                  else buttons.current.delete(item.id);
                }}
                id={buttonId}
                type="button"
                className={styles.trigger}
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
                onKeyDown={(event) => onHeaderKeyDown(event, index)}
              >
                <span className={styles.label}>{item.heading}</span>
                <ChevronRightIcon className={styles.icon} size={20} />
              </button>
            </Heading>
            {/* Etiketli <section> ortuk `region` rolu tasir (APG panel). */}
            <section
              id={panelId}
              aria-labelledby={buttonId}
              className={styles.panel}
              hidden={!expanded}
            >
              {item.content}
            </section>
          </div>
        );
      })}
    </div>
  );
}
