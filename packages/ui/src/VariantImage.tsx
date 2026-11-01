"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ImageVariants } from "./image-variants.ts";

export interface VariantImageProps {
  variants: ImageVariants;
  /** `srcset` ile birlikte verilir; verilmezse yalnizca tek `src` kullanilir. */
  sizes?: string;
  alt: string;
  className: string;
  style?: CSSProperties | undefined;
  loading: "lazy" | "eager";
  width?: number | undefined;
  height?: number | undefined;
  fetchPriority?: "high" | "low" | "auto" | undefined;
  referrerPolicy?: "no-referrer" | undefined;
}

/**
 * Yuksek cozunurluklu varyantli gorsel (karar 0166). Varyant yuklenemezse
 * (CDN 4xx, ag hatasi) TARAYICIDA bir kez katalogdaki orijinal URL'ye duser;
 * orijinal de kirikse `ProductImage`daki notr `--surface` kutusu kalir.
 *
 * Gorsel hidrasyondan ONCE hata verdiyse `onError` kacar; bu yuzden baglanti
 * sonrasi `complete && naturalWidth === 0` ayrica denetlenir (`FallbackImage` ile
 * ayni desen, karar 0077). JS yoksa varyant `src` olarak gosterilir.
 */
export function VariantImage({
  variants,
  sizes,
  alt,
  className,
  style,
  loading,
  width,
  height,
  fetchPriority,
  referrerPolicy,
}: VariantImageProps) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    if (!failed && img?.complete && img.naturalWidth === 0) setFailed(true);
  }, [failed]);

  const useVariant = !failed;
  return (
    <img
      key={useVariant ? "variant" : "original"}
      ref={ref}
      src={useVariant ? variants.src : variants.original}
      srcSet={useVariant && sizes ? variants.srcSet : undefined}
      sizes={useVariant && sizes ? sizes : undefined}
      alt={alt}
      loading={loading}
      decoding="async"
      fetchPriority={fetchPriority}
      referrerPolicy={referrerPolicy}
      width={width}
      height={height}
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
