"use client";

import { ProductImage } from "@arilla/ui";
import { type KeyboardEvent, useRef, useState } from "react";
import { clampIndex, mainImageAlt, nextIndex, thumbLabel } from "./product-gallery-state.ts";
import styles from "./product-page.module.css";

/**
 * Ana görselin ve küçük resmin ekrandaki genişliği (`sizes`, karar 0167). Değerler
 * `product-page.module.css` düzeninin (`.hero`, `.mediaFrame` iç boşluğu, küçük resim 4,5rem)
 * gerçek tarayıcı ölçümlerinden: ana görsel 360→278, 390→308, 639→557, 640→542, 1023→925,
 * 1024→407, 1280→546, ≥1344→581 px; küçük resim 62 px. Düzen değişirse güncellenir.
 */
const GALLERY_MAIN_SIZES =
  "(min-width: 1344px) 581px, (min-width: 1024px) calc((100vw - 279px) * 6 / 11), (min-width: 640px) calc(100vw - 98px), calc(100vw - 82px)";
const GALLERY_THUMB_SIZES = "62px";

export interface GalleryImageView {
  url: string;
  width: number | null;
  height: number | null;
}

export interface ProductGalleryClientProps {
  title: string;
  /** En fazla MAX_DISPLAY_IMAGES; sunucu `r2 ?? source ?? legacy` zaten secti. */
  images: readonly GalleryImageView[];
  /**
   * AliExpress CDN varyantları (karar 0167). Bayrak sunucuda okunur ve prop olarak gelir:
   * istemci bileşeninde ortam değişkeni okunamaz, SSR ile hidrasyon aynı değeri görmeli.
   */
  aliexpressVariants?: boolean;
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
export function ProductGalleryClient({
  title,
  images,
  aliexpressVariants = false,
}: ProductGalleryClientProps) {
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
          sizes={GALLERY_MAIN_SIZES}
          aliexpress={aliexpressVariants}
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
                  sizes={GALLERY_THUMB_SIZES}
                  aliexpress={aliexpressVariants}
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
