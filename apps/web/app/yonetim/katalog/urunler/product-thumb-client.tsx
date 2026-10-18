"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Ürün görseli: tembel yüklenir; mağaza adresi yanıt vermezse (silinmiş görsel,
 * engelli CDN) kırık simge yerine "görsel yok" kutusu gösterilir. Adres sunucuda
 * http(s) ile sınırlandı (`httpUrl`); yönlendiren bilgisi gönderilmez.
 */
export function ProductThumb({
  src,
  size,
  className,
  emptyClassName,
  lazy = true,
}: {
  src: string | null;
  size: number;
  className?: string;
  emptyClassName?: string;
  lazy?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // Hidrasyondan önce yüklenemeyen görselin `error` olayı kaçmış olabilir.
  useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  if (!src || failed) {
    return <span className={emptyClassName}>görsel yok</span>;
  }
  return (
    // biome-ignore lint/performance/noImgElement: keyfi mağaza host'ları (match-queue-client ile aynı desen).
    <img
      ref={ref}
      src={src}
      alt=""
      width={size}
      height={size}
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
