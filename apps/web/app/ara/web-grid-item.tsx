"use client";

import { type ReactNode, useEffect, useState } from "react";

/**
 * Internet sonucu kartinin kapsayicisi (karar 0102). Sunucu gorselin varligini
 * dogrulamistir; yine de tarayici gorseli yukleyemezse (kirik adres, engel)
 * kart tamamen gizlenir: gorselsiz internet urunu gosterilmez. Gizleme
 * `data-broken` ile isaretlenir; bos kalan grup/bolum CSS `:has` ile kapanir.
 * Gorsel istegi `no-referrer` ile yapilir (karttaki gorselle ayni).
 */
export function WebGridItem({
  className,
  imageUrl,
  children,
}: {
  className?: string;
  imageUrl: string;
  children: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
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
      className={className}
      data-web-item=""
      {...(broken ? { "data-broken": "true", hidden: true, style: { display: "none" } } : {})}
    >
      {children}
    </li>
  );
}
