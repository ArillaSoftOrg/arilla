"use client";

import { useEffect, useRef, useState } from "react";
import { joinClassNames } from "./layout.ts";
import styles from "./ProductImage.module.css";

export interface FallbackImageProps {
  /** Denenecek adaylar, oncelik sirasinda. Ilk yuklenen gosterilir; hepsi kirik olursa yer tutucu. */
  srcs: readonly string[];
  alt: string;
  className?: string;
  /** Hicbir aday yuklenmediginde cizilen notr kutunun sinifi (oran/boyut cagirandan gelir). */
  placeholderClassName?: string;
  loading?: "lazy" | "eager";
  fit?: "cover" | "contain";
  fetchPriority?: "high" | "low" | "auto";
}

/**
 * Kirik gorsel yedegi (karar 0077): adaylari TARAYICIDA sirayla dener. Sunucuda
 * HEAD istegi YOK; katalogda gorsel canlilik sinyali (`offer_image.status`
 * 'broken') henuz dolmuyor, bu yuzden en ucuz genel cozum `onError` zinciri.
 *
 * Gorsel hidrasyondan ONCE hata verdiyse `onError` kacar; bu yuzden baglanti
 * sonrasi `complete && naturalWidth === 0` ayrica denetlenir. JS yoksa ilk aday
 * gosterilir, kirikse `ProductImage`daki gibi notr `--surface` kutusu kalir.
 * Yalnizca trend kapagi kullanir; `ProductImage` ve urun sayfalari degismedi.
 */
export function FallbackImage({
  srcs,
  alt,
  className,
  placeholderClassName,
  loading = "lazy",
  fit = "cover",
  fetchPriority,
}: FallbackImageProps) {
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLImageElement>(null);
  const src = srcs[index];

  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` degisince yeni gorsel denetlenir.
  useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) setIndex((i) => i + 1);
  }, [index]);

  if (src === undefined) {
    return <div className={placeholderClassName} aria-hidden="true" />;
  }
  return (
    <img
      key={src}
      ref={ref}
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      fetchPriority={fetchPriority}
      className={joinClassNames(styles.image, fit === "contain" && styles.contain, className)}
      onError={() => setIndex((i) => i + 1)}
    />
  );
}
