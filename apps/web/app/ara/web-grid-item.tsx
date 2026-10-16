"use client";

import { ProductCard } from "@arilla/ui";
import { type ReactNode, useEffect, useState } from "react";
import styles from "./ara.module.css";
import { WEB_SEARCH_COPY as COPY } from "./web-search-copy.ts";

/**
 * Internet sonucu karti (karar 0102, 0106). Sunucu gorselin varligini dogrulamistir;
 * yine de tarayici gorseli yukleyemezse (kirik adres, engel) urun KAYBOLMAZ:
 * gorselsiz kompakt karta doner. Gorsel istegi `no-referrer` ile yapilir
 * (karttaki gorselle ayni). Dogrudan magaza baglantisi, izleme yok.
 */
export function WebGridItem({
  className,
  href,
  title,
  brand,
  imageUrl,
  minPrice,
  offerCount,
  children,
}: {
  className?: string;
  href: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
  children?: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!imageUrl) return;
    const probe = new Image();
    probe.referrerPolicy = "no-referrer";
    probe.onerror = () => setBroken(true);
    probe.src = imageUrl;
    return () => {
      probe.onerror = null;
    };
  }, [imageUrl]);
  return (
    <li
      className={[className, styles.webItem, imageUrl && !broken ? "" : styles.webItemCompact]
        .filter(Boolean)
        .join(" ")}
    >
      <ProductCard
        href={href}
        external
        compactWithoutImage
        title={title}
        brand={brand}
        imageUrl={broken ? null : imageUrl}
        minPrice={minPrice}
        priceLabel={COPY.priceUnverified}
        offerCount={offerCount}
        offerCountLabel={COPY.storeCount}
      />
      {children}
    </li>
  );
}
