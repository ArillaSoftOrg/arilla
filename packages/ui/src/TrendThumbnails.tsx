"use client";

import { useEffect, useRef, useState } from "react";
import { ProductImage } from "./ProductImage.tsx";
import styles from "./TrendCollectionCard.module.css";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

export interface TrendThumbnailProduct {
  id: string;
  title: string;
  brand?: string;
  imageUrl: string;
}

function Thumb({ product, onBroken }: { product: TrendThumbnailProduct; onBroken: () => void }) {
  const wrapper = useRef<HTMLLIElement>(null);

  // Hidrasyondan ONCE hata veren gorselde `onError` kacar: baglanti sonrasi denetlenir.
  useEffect(() => {
    const img = wrapper.current?.querySelector("img");
    if (img?.complete && img.naturalWidth === 0) onBroken();
  }, [onBroken]);

  return (
    <li ref={wrapper} className={styles.productItem} onErrorCapture={onBroken}>
      {/* Ad hemen yaninda (gizli metin) - gorsel dekoratif, alt="". */}
      <ProductImage src={product.imageUrl} alt="" className={styles.productImage} fit="contain" />
      <VisuallyHidden>
        {product.brand ? `${product.brand} ${product.title}` : product.title}
      </VisuallyHidden>
    </li>
  );
}

/**
 * Trend kartinin kucuk urun onizlemeleri (karar 0077). `products` bir HAVUZDUR
 * (gorunenden fazla olabilir): gorseli kirik olan cikarilir, yerine havuzdaki
 * sonraki urun gelir; havuz tukenirse bos gri kutu birakilmaz, daha az onizleme
 * gosterilir. Kontrol tarayicidadir (`onError`), sunucuda HEAD istegi yoktur.
 * Yalnizca trend karti kullanir; `ProductCard` degismedi.
 */
export function TrendThumbnails({
  products,
  visibleCount,
  moreText,
}: {
  products: readonly TrendThumbnailProduct[];
  visibleCount: number;
  moreText?: string;
}) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const shown = products.filter((product) => !broken.has(product.id)).slice(0, visibleCount);
  if (shown.length === 0 && !moreText) return null;

  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur.
    <ul role="list" className={styles.productList}>
      {shown.map((product) => (
        <Thumb
          key={product.id}
          product={product}
          onBroken={() => setBroken((current) => new Set(current).add(product.id))}
        />
      ))}
      {moreText ? (
        <li className={styles.more} aria-hidden="true">
          {moreText}
        </li>
      ) : null}
    </ul>
  );
}
