"use client";

import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { trackEvent } from "../lib/track-event.ts";
import styles from "./discover.module.css";

/** `grid-auto-rows` ile aynı olmalı (discover.module.css `--row-unit`). */
const ROW_UNIT = 2;
/** Görsel kutusunun kabul ettiği oran aralığı; dışındaki görseller kırpılmaz, `contain` olur. */
const MIN_RATIO = 0.66;
const MAX_RATIO = 1.4;

function applyRatio(img: HTMLImageElement) {
  const media = img.closest<HTMLElement>("[data-discover-media]");
  if (!media || img.naturalWidth === 0 || img.naturalHeight === 0) return;
  const ratio = img.naturalWidth / img.naturalHeight;
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  media.style.setProperty("--discover-ratio", String(clamped));
  media.dataset.fit = clamped === ratio ? "cover" : "contain";
}

/**
 * Sıra-koruyan masonry: DOM sırası mantıksal sırayla aynı (Tab/ekran okuyucu =
 * görsel okuma sırası); `<li>`'ler CSS grid'de soldan sağa akar ve ölçülen
 * yüksekliğe göre `grid-row-end: span N` alır. Ölçüm yalnızca yerleşimi
 * inceltir: JS yokken/ölçümden önce ızgara doğal yükseklikle düzgün görünür.
 * Kartlar sunucu bileşeni; görsel oranı `load` olayı yakalanarak okunur
 * (kart başına ayrı hidrasyon adası yok).
 */
export function DiscoverMasonry({
  children,
  labelledBy,
}: {
  children: ReactNode;
  labelledBy: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  const layout = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    for (const item of list.children) {
      const li = item as HTMLElement;
      const card = li.firstElementChild as HTMLElement | null;
      if (!card) continue;
      const gap = Number.parseFloat(getComputedStyle(li).paddingBlockEnd) || 0;
      const span = Math.ceil((card.getBoundingClientRect().height + gap) / ROW_UNIT);
      li.style.gridRowEnd = `span ${span}`;
    }
    list.dataset.masonry = "ready";
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Hidrasyondan önce yüklenmiş görseller `load` olayını kaçırmış olabilir.
    for (const img of list.querySelectorAll("img")) {
      if (img.complete) applyRatio(img);
    }
    layout();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(layout);
    for (const li of list.children) {
      if (li.firstElementChild) observer.observe(li.firstElementChild);
    }
    return () => observer.disconnect();
  }, [layout]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegasyon; tıklanan bağlantılar zaten klavyeyle etkinleşir.
    <ul
      ref={listRef}
      className={styles.grid}
      aria-labelledby={labelledBy}
      onClick={(event) => {
        // Karar 0219: yalnızca etkileşim türü; hangi ürün olduğu gönderilmez.
        if (event.target instanceof Element && event.target.closest("a[href]")) {
          trackEvent("discover_interaction", { interaction_type: "card_click" });
        }
      }}
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLImageElement) {
          applyRatio(event.target);
          layout();
        }
      }}
    >
      {children}
    </ul>
  );
}
