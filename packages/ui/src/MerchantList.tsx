import styles from "./MerchantList.module.css";

export interface MerchantOfferRow {
  offerId: number;
  merchantName: string;
  totalLabel: string;
  shippingLabel: string;
  inStock: boolean;
  exitHref: string;
  exitLabel: string;
}

export interface MerchantListProps {
  offers: readonly MerchantOfferRow[];
  /** docs/copy.md `product.out_of_stock`: "Şu an stokta yok". */
  outOfStockLabel: string;
  /** Verilirse stoktaki satirda gosterilir ("Stokta"). */
  inStockLabel?: string;
  /**
   * Verilirse bir satir bu etiketle isaretlenir ("En uygun fiyat"):
   * `bestOfferId` verilmisse o teklif, verilmemisse ilk satir (siralama
   * `compareMerchants()`'tan, kargo dahil toplama gore).
   */
  bestOfferLabel?: string;
  /** Isaretlenecek teklif (orn. stokta olan en uygun teklif). */
  bestOfferId?: number | string;
  /** Liste icin erisilebilir ad (ör. bolum basliginin id'si). */
  "aria-labelledby"?: string;
}

/**
 * docs/pages.md "Mağaza listesi": fiyat, kargo dahil toplam, stok, çıkış
 * düğmesi. Sıralama zaten `compareMerchants()`'ta (C2) kargo dahil toplama
 * göre yapılıyor - burada yeniden sıralanmaz. Mağaza logosu yok (design.md
 * "Karara bağlanacaklar" - repo genelinde henüz çözülmemiş).
 *
 * Satir mobilde alt alta (ad + toplam, meta, tam genislik cikis), genis
 * ekranda tek satir: ad/meta | toplam | cikis.
 */
export function MerchantList({
  offers,
  outOfStockLabel,
  inStockLabel,
  bestOfferLabel,
  bestOfferId,
  "aria-labelledby": labelledBy,
}: MerchantListProps) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolunu dusurur.
    <ul className={styles.list} role="list" aria-labelledby={labelledBy}>
      {offers.map((offer, index) => {
        const isBest =
          bestOfferLabel !== undefined &&
          (bestOfferId !== undefined ? offer.offerId === bestOfferId : index === 0);
        return (
          <li key={offer.offerId} className={styles.row}>
            <div className={styles.info}>
              <span className={styles.merchantName}>{offer.merchantName}</span>
              {isBest ? <span className={styles.best}>{bestOfferLabel}</span> : null}
              <span className={styles.meta}>
                <span>{offer.shippingLabel}</span>
                {offer.inStock ? (
                  inStockLabel ? (
                    <span className={styles.inStock}>{inStockLabel}</span>
                  ) : null
                ) : (
                  <span className={styles.outOfStock}>{outOfStockLabel}</span>
                )}
              </span>
            </div>
            <span className={`${styles.total} tabular-nums`}>{offer.totalLabel}</span>
            {/* attribution: CLAUDE.md kural 8 - dogrudan offer.url'e degil, /git uzerinden. */}
            <a href={offer.exitHref} className={styles.exit}>
              {offer.exitLabel}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
