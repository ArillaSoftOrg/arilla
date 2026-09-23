"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import styles from "./ProductImage.module.css";

export interface ProductImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** Varsayilan "lazy". Yalnizca ilk ekranda gorunen gorsel icin "eager"
   * (Faz 7 - LCP gorseli lazy olunca gec baslar). */
  loading?: "lazy" | "eager";
}

/**
 * Kirik/yuklenemeyen harici gorsel icin zarif dusme - `TrendCollectionCard`
 * ve `DiscoveryCard` bu tek bilesenden paylasilan gorsel gosterimini kullanir
 * (fallback mantigi iki yerde tekrarlanmaz). Gorseller marka sitelerinden
 * hotlink edilir (bkz. apps/web/data/demo/SOURCES.md), URL'leri zamanla
 * degisebilir/kaldirilabilir. ProductCard.module.css .imagePlaceholder ile
 * ayni notr desen.
 */
export function ProductImage({ src, alt, className, style, loading = "lazy" }: ProductImageProps) {
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
      loading={loading}
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
