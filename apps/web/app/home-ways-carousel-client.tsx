"use client";

import { ProductImage } from "@arilla/ui";
import { useRef } from "react";
import styles from "./home.module.css";

export interface HomeWayCard {
  id: string;
  title: string;
  imageUrl: string;
  imageAlt: string;
  tone: "aqua" | "mist" | "warm";
  mockLabel?: string;
}

export function HomeWaysCarousel({
  title,
  items,
}: {
  title: string;
  items: readonly HomeWayCard[];
}) {
  const scrollerRef = useRef<HTMLUListElement>(null);

  function scrollByCard(direction: -1 | 1) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const firstCard = scroller.querySelector("li");
    const distance = firstCard?.getBoundingClientRect().width ?? scroller.clientWidth * 0.8;
    scroller.scrollBy({ left: direction * (distance + 24), behavior: "smooth" });
  }

  return (
    <div className={styles.ways}>
      <div className={styles.waysHeader}>
        <h2 id="nasil-calisir-baslik" className={styles.waysTitle}>
          {title}
        </h2>
        <div className={styles.waysControls} aria-label={`${title} kartlarını gez`}>
          <button
            type="button"
            className={styles.waysControl}
            aria-label="Önceki kart"
            onClick={() => scrollByCard(-1)}
          >
            ←
          </button>
          <button
            type="button"
            className={styles.waysControl}
            aria-label="Sonraki kart"
            onClick={() => scrollByCard(1)}
          >
            →
          </button>
        </div>
      </div>

      {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
      <ul ref={scrollerRef} role="list" className={styles.waysTrack}>
        {items.map((item) => (
          <li key={item.id} className={styles.wayItem}>
            <article className={`${styles.wayCard} ${styles[`wayCard_${item.tone}`]}`}>
              <div className={styles.wayVisual}>
                {item.mockLabel ? <div className={styles.wayMockLabel}>{item.mockLabel}</div> : null}
                <ProductImage
                  src={item.imageUrl}
                  alt={item.imageAlt}
                  className={styles.wayImage}
                  fit="contain"
                />
                <span className={styles.playBadge} aria-hidden="true" />
              </div>
              <h3 className={styles.wayCaption}>{item.title}</h3>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}
