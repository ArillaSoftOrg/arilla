import type { ReactNode } from "react";
import { formatStartingPrice, formatTRY } from "./format.ts";
import styles from "./ProductCard.module.css";
import { ProductImage } from "./ProductImage.tsx";

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
}: ProductCardProps) {
  const metaLabel = offerCount !== undefined && offerCountLabel ? offerCountLabel(offerCount) : "";

  const card = (
    <a href={href} className={styles.card}>
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
            className={styles.image}
          />
        ) : null}
      </span>
      <span className={styles.body}>
        {brand ? <span className={styles.brand}>{brand}</span> : null}
        <span className={styles.title}>{title}</span>
        <span className={styles.price}>
          {minPrice === null
            ? "—"
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
