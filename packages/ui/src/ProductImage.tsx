"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import styles from "./ProductImage.module.css";

export interface ProductImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Kirik/yuklenemeyen harici gorsel icin zarif dusme - `TrendCollectionCard`
 * ve `DiscoveryCard` bu tek bilesenden paylasilan gorsel gosterimini kullanir
 * (fallback mantigi iki yerde tekrarlanmaz). Gorseller marka sitelerinden
 * hotlink edilir (bkz. apps/web/data/demo/SOURCES.md), URL'leri zamanla
 * degisebilir/kaldirilabilir. ProductCard.module.css .imagePlaceholder ile
 * ayni notr desen.
 */
export function ProductImage({ src, alt, className, style }: ProductImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`${styles.fallback} ${className ?? ""}`}
        style={style}
        role="img"
        aria-label={alt}
      />
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
