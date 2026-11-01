import type { ReactNode } from "react";
import { formatStartingPrice, formatTRY } from "./format.ts";
import styles from "./ProductCard.module.css";
import { ProductImage } from "./ProductImage.tsx";

/**
 * Kart gorselinin ekrandaki genisligi (`sizes`, karar 0166). Degerler `/ara`
 * izgarasinin (`ara.module.css` .grid: 2/3/4/5 sutun, 640/1024/1440) VE kartin
 * `.media` ic boslugunun (2 x 12px) + kenarlik (2px) gercek olcumlerinden gelir
 * (tarayici olcumu: 360->132, 390->147, 768->203, 1024->202, 1280->266, 1440->217 px).
 * Izgara ya da kart boslugu degisirse burasi guncellenir; yanlis (buyuk) deger
 * yalnizca gereksiz buyuk dosya indirtir, bulaniklik uretmez.
 */
export const PRODUCT_GRID_IMAGE_SIZES =
  "(min-width: 1440px) 217px, (min-width: 1344px) 282px, (min-width: 1024px) calc((100vw - 216px) / 4), (min-width: 640px) calc((100vw - 158px) / 3), calc(50vw - 48px)";

export interface ProductCardProps {
  href: string;
  title: string;
  imageUrl: string | null;
  /** Kurus cinsinden, docs/schema.sql: para asla float degil. */
  minPrice: number | null;
  /**
   * 0037: `minPrice` varyantlar arasi baslangic fiyatiysa true
   * ("670 TL'den başlayan"); tek ticari varyantli urunde verilmez.
   */
  priceFrom?: boolean;
  /** Verilmezse magaza sayisi satiri cizilmez (orn. `/firsatlar`, alternatifler). */
  offerCount?: number;
  /**
   * docs/copy.md `search.offer_count` vb. cagiran taraf saglar - burada sabit
   * metin yok. Verilmezse veya bos metin donerse meta satiri hic cizilmez
   * (orn. `AlternativeProduct`'ta magaza sayisi yok).
   */
  offerCountLabel?: (count: number) => string;
  /** Marka adi - yalnizca veride gercekten varsa (`SearchResultItem.brandName`). */
  brand?: string | null;
  /** Varsayilan "lazy". Yalnizca ilk ekranda gorunen kart icin "eager". */
  imageLoading?: "lazy" | "eager";
  /**
   * Istege bagli kart ustu eylem (orn. `/kaydettiklerim` kaydi kaldirma
   * dugmesi), gorselin sag ust kosesinde. Baglantinin ICINDE degil, kardes
   * ogedir (etkilesimli oge ic ice gecmez); tiklamasi gezinme yapmaz.
   * Verilmezse isaretleme degismez.
   */
  action?: ReactNode;
  /**
   * Fiyat yoksa ("—" yerine) gosterilecek durum etiketi; ör. internet
   * sonucunda dogrulanamayan fiyat icin "Fiyat mağazada". Fiyat varsa kullanilmaz.
   */
  priceLabel?: string;
  /** Kaynak/dogrulama rozeti (ör. "İnternetten"); verilmezse cizilmez. */
  sourceLabel?: string;
  /** Dis magaza baglantisi: yeni sekmede, izleme/yonlendirici bilgisi olmadan acilir. */
  external?: boolean;
  /** Gorsel yoksa bos kare alan ayirma; kompakt (yalnizca metin) kart cizer. */
  compactWithoutImage?: boolean;
  /** Gorselin ekrandaki genisligi (`sizes`); kartin icinde durdugu izgaraya gore. Varsayilan: `/ara` izgarasi. */
  imageSizes?: string;
}

/**
 * docs/pages.md "Ürün kartı": foto, başlık, fiyat, mağaza sayısı. Kartin
 * tamami tek bir baglantidir; gorsel dekoratiftir (`alt=""`) cunku ayni
 * bilgiyi baglanti metnindeki baslik zaten tasir - ekran okuyucu basligi iki
 * kez okumaz. Kirik gorselde `alt=""` tarayiciya hicbir sey cizdirmez, ayrilmis
 * kare alan `--surface` zemini olarak kalir.
 */
export function ProductCard({
  href,
  title,
  imageUrl,
  minPrice,
  priceFrom = false,
  offerCount,
  offerCountLabel,
  brand,
  imageLoading = "lazy",
  action,
  priceLabel,
  sourceLabel,
  external = false,
  compactWithoutImage = false,
  imageSizes = PRODUCT_GRID_IMAGE_SIZES,
}: ProductCardProps) {
  const metaLabel = offerCount !== undefined && offerCountLabel ? offerCountLabel(offerCount) : "";

  const card = (
    <a
      href={href}
      className={styles.card}
      {...(external ? { target: "_blank", rel: "nofollow noopener noreferrer sponsored" } : {})}
    >
      {imageUrl || !compactWithoutImage ? (
        <span className={styles.media}>
          {imageUrl ? (
            // design.md "Kutu modeli": fotograf kartin icinde kalir (contain) -
            // DiscoveryCard ve urun sayfasiyla ayni cerceve; kirik gorselde
            // ProductImage'in --surface yedegi.
            <ProductImage
              src={imageUrl}
              alt=""
              fit="contain"
              loading={imageLoading}
              sizes={imageSizes}
              className={styles.image}
              {...(external ? { referrerPolicy: "no-referrer" as const } : {})}
            />
          ) : null}
        </span>
      ) : null}
      <span className={styles.body}>
        {sourceLabel ? <span className={styles.source}>{sourceLabel}</span> : null}
        {brand ? <span className={styles.brand}>{brand}</span> : null}
        <span className={styles.title}>{title}</span>
        <span className={styles.price}>
          {minPrice === null
            ? (priceLabel ?? "—")
            : priceFrom
              ? formatStartingPrice(minPrice)
              : formatTRY(minPrice)}
        </span>
        {metaLabel ? <span className={styles.meta}>{metaLabel}</span> : null}
      </span>
    </a>
  );

  if (!action) return card;
  return (
    <div className={styles.withAction}>
      {card}
      <div className={styles.action}>{action}</div>
    </div>
  );
}
