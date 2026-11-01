import type { CSSProperties } from "react";
import { resolveImageVariants } from "./image-variants.ts";
import { joinClassNames } from "./layout.ts";
import styles from "./ProductImage.module.css";
import { VariantImage } from "./VariantImage.tsx";

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
  /** Ucuncu taraf sunucudan hotlink icin "no-referrer" (sayfa adresi sizdirilmaz). */
  referrerPolicy?: "no-referrer";
  /**
   * Gorselin ekrandaki genisligi (`sizes` ozniteligi, orn. "(min-width: 768px) 240px, 46vw").
   * Dogrulanmis bir varyant kaynagi (bkz. `image-variants.ts`) icin `srcset` ancak
   * bununla uretilir; verilmezse tek orta boyut kullanilir. Taninmayan kaynakta etkisiz.
   */
  sizes?: string;
  /**
   * AliExpress CDN varyantlari (karar 0167). Varsayilan kapali; cagiran SUNUCUDA
   * `isAliExpressImageVariantsEnabled()` ile okuyup verir (istemci bilesenlerinde ortam
   * degiskeni okunamaz, bu yuzden dogrudan prop). Hepsiburada bundan etkilenmez.
   */
  aliexpress?: boolean;
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
  referrerPolicy,
  sizes,
  aliexpress = false,
}: ProductImageProps) {
  const mergedStyle: CSSProperties | undefined =
    aspectRatio !== undefined ? { aspectRatio, ...style } : style;
  const classes = joinClassNames(styles.image, fit === "contain" && styles.contain, className);

  // Karar 0166: kucuk resim olarak kayitli bilinen CDN gorselleri icin dogrulanmis
  // buyuk varyant + `srcset`; yuklenemezse orijinal URL'ye duser. Taninmayan kaynak
  // (AliExpress, Shopify vb.) asagidaki degismemis yolu izler.
  const variants = resolveImageVariants(src, { aliexpress });
  if (variants) {
    return (
      <VariantImage
        variants={variants}
        {...(sizes !== undefined ? { sizes } : {})}
        alt={alt}
        className={classes}
        style={mergedStyle}
        loading={loading}
        width={width}
        height={height}
        fetchPriority={fetchPriority}
        referrerPolicy={referrerPolicy}
      />
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      fetchPriority={fetchPriority}
      referrerPolicy={referrerPolicy}
      width={width}
      height={height}
      className={classes}
      style={mergedStyle}
    />
  );
}
