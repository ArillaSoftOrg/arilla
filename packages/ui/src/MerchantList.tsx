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
}

/**
 * docs/pages.md "Mağaza listesi": fiyat, kargo dahil toplam, stok, çıkış
 * düğmesi. Sıralama zaten `compareMerchants()`'ta (C2) kargo dahil toplama
 * göre yapılıyor - burada yeniden sıralanmaz. Mağaza logosu yok (design.md
 * "Karara bağlanacaklar" - repo genelinde henüz çözülmemiş).
 */
export function MerchantList({ offers, outOfStockLabel }: MerchantListProps) {
  return (
    <ul className={styles.list}>
      {offers.map((offer) => (
        <li key={offer.offerId} className={styles.row}>
          <div className={styles.info}>
            <span className={styles.merchantName}>{offer.merchantName}</span>
            <span className={styles.shipping}>{offer.shippingLabel}</span>
            {!offer.inStock ? <span className={styles.outOfStock}>{outOfStockLabel}</span> : null}
          </div>
          <span className={`${styles.total} tabular-nums`}>{offer.totalLabel}</span>
          {/* attribution: CLAUDE.md kural 8 - dogrudan offer.url'e degil, /git uzerinden. */}
          <a href={offer.exitHref} className={styles.exit}>
            {offer.exitLabel}
          </a>
        </li>
      ))}
    </ul>
  );
}
