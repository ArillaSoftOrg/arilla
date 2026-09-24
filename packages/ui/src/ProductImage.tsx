import type { CSSProperties } from "react";
import { joinClassNames } from "./layout.ts";
import styles from "./ProductImage.module.css";

export interface ProductImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** Varsayilan "lazy". Yalnizca ilk ekranda gorunen gorsel icin "eager"
   * (Faz 7 - LCP gorseli lazy olunca gec baslar). */
  loading?: "lazy" | "eager";
  /** Gercek piksel boyutu biliniyorsa verilir; tarayici yer ayirir. */
  width?: number;
  height?: number;
  /** Orn. "4 / 5" veya 1. Verilirse gorsel bu oranda yer ayirir (duzen
   * kaymasi yok); `style.aspectRatio` hala onceliklidir. */
  aspectRatio?: CSSProperties["aspectRatio"];
  /** Varsayilan "cover": kutuyu doldurur. "contain": beyaz zeminli urun
   * fotografini kirpmadan gosterir. */
  fit?: "cover" | "contain";
  /** LCP gorseli icin "high"; varsayilan tarayiciya birakilir. */
  fetchPriority?: "high" | "low" | "auto";
}

/**
 * Paylasilan urun gorseli - `TrendCollectionCard` ve `DiscoveryCard` bu tek
 * bilesenden gecer. Gorseller marka sitelerinden hotlink edilir (bkz.
 * apps/web/data/demo/SOURCES.md), URL'leri zamanla degisebilir/kaldirilabilir.
 *
 * Server Component: kirik gorsel icin istemci durumu (`onError`) tutulmaz,
 * boylece her kart ayri bir hidrasyon adasi olmaz. Dusme yalnizca CSS ile:
 * gorselin zemini `--surface`, alt metni gorsel olarak saydam (ekran okuyucu
 * okur), kirik gorselde `::before` ayni kutuyu `--surface` ile kaplar
 * (Chromium/Firefox; Safari'de kucuk kirik ikon `--surface` kutuda kalir).
 */
export function ProductImage({
  src,
  alt,
  className,
  style,
  loading = "lazy",
  width,
  height,
  aspectRatio,
  fit = "cover",
  fetchPriority,
}: ProductImageProps) {
  const mergedStyle: CSSProperties | undefined =
    aspectRatio !== undefined ? { aspectRatio, ...style } : style;

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      fetchPriority={fetchPriority}
      width={width}
      height={height}
      className={joinClassNames(styles.image, fit === "contain" && styles.contain, className)}
      style={mergedStyle}
    />
  );
}
