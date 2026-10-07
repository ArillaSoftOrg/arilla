"use client";

import { ProductImage } from "@arilla/ui";
import { type KeyboardEvent, useRef, useState } from "react";
import { clampIndex, mainImageAlt, nextIndex, thumbLabel } from "./product-gallery-state.ts";
import styles from "./product-page.module.css";

export interface GalleryImageView {
  url: string;
  width: number | null;
  height: number | null;
}

export interface ProductGalleryClientProps {
  title: string;
  /** En fazla MAX_DISPLAY_IMAGES; sunucu `r2 ?? source ?? legacy` zaten secti. */
  images: readonly GalleryImageView[];
}

/**
 * Urun detay galerisi (karar 0073): buyuk ana gorsel + en fazla 3 kucuk resim.
 * - 0 gorsel: yer tutucu (eski gorunum). 1 gorsel: kucuk resim YOK, bugunku
 *   gorunumle ayni isaretleme.
 * - Ana gorsel kare cerceveye oturur (`aspect-ratio`): gorsel degisince yerlesim
 *   kaymaz. Kucuk resimler ana gorselle ayni URL'yi kullanir; secimde tarayici
 *   onbellegi yeterlidir, yeni indirme olmaz.
 * - Klavye: kucuk resimler Tab ile girilen tek duraktir (roving tabindex);
 *   ok tuslari/Home/End secimi ve odagi tasir.
 */
export function ProductGalleryClient({ title, images }: ProductGalleryClientProps) {
  const [selected, setSelected] = useState(0);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (images.length === 0) {
    return (
      <div className={styles.media}>
        <div className={styles.mediaFrame}>
          <div className={styles.mediaPlaceholder} aria-hidden="true" />
        </div>
      </div>
    );
  }

  const count = images.length;
  const index = clampIndex(selected, count);
  const current = images[index] as GalleryImageView;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, from: number) {
    const target = nextIndex(from, event.key, count);
    if (target === null) return;
    event.preventDefault();
    setSelected(target);
    thumbRefs.current[target]?.focus();
  }

  return (
    <div className={styles.media}>
      <div className={styles.mediaFrame}>
        <ProductImage
          src={current.url}
          alt={mainImageAlt(title, index, count)}
          // LCP: ilk gorsel eager + yuksek oncelik; sonrakiler secimle ayni URL'yi degistirir.
          loading="eager"
          fetchPriority={index === 0 ? "high" : "auto"}
          fit="contain"
          className={styles.image}
          {...(current.width && current.height
            ? { width: current.width, height: current.height }
            : {})}
        />
      </div>
      {count > 1 ? (
        <ul className={styles.thumbs} aria-label="Ürün görselleri">
          {images.map((image, i) => (
            <li key={image.url} className={styles.thumbItem}>
              <button
                type="button"
                ref={(node) => {
                  thumbRefs.current[i] = node;
                }}
                className={i === index ? `${styles.thumb} ${styles.thumbActive}` : styles.thumb}
                aria-label={thumbLabel(title, i, count)}
                aria-pressed={i === index}
                tabIndex={i === index ? 0 : -1}
                onClick={() => setSelected(i)}
                onKeyDown={(event) => onKeyDown(event, i)}
              >
                <ProductImage
                  src={image.url}
                  alt=""
                  loading={i === 0 ? "eager" : "lazy"}
                  fit="cover"
                  className={styles.thumbImage}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
