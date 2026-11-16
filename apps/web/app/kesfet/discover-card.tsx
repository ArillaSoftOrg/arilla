import { type DiscoveryItem, ProductImage } from "@arilla/ui";
import styles from "./discover.module.css";

/** Oran bilinmeden önce ayrılan yer (4:5): CLS'i azaltır; yüklenince gerçek oran uygulanır. */
const IMAGE_SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw";

/**
 * Keşfet kartı: görsel kartın ana öğesi, alt kısımda yarı saydam bilgi katmanı.
 * Tüm kart tek bağlantıdır (başlık `<a>` + `::after` kaplaması); odak ve ekran
 * okuyucu için tek durak. Oran ölçümü ve masonry yerleşimi `DiscoverMasonry`
 * (istemci) tarafında, kartın kendisi sunucu bileşeni kalır.
 * Mağaza adı, keşif zamanı vb. veride yok → gösterilmez; yalnızca mevcut
 * `priceLabel` ve "N mağaza" (`metaLabel`).
 */
export function DiscoverCard({ item, priority }: { item: DiscoveryItem; priority: boolean }) {
  const title = item.href ? (
    <a href={item.href} className={styles.link}>
      {item.title}
    </a>
  ) : (
    <span className={styles.link}>{item.title}</span>
  );

  return (
    <li className={styles.item}>
      <article className={styles.card}>
        <div className={styles.media} data-discover-media>
          <ProductImage
            src={item.imageUrl}
            // Başlık bağlantı metni; görsel dekoratif (çift okunmasın).
            alt={item.href ? "" : item.imageAlt}
            className={styles.image}
            loading={priority ? "eager" : "lazy"}
            {...(priority ? { fetchPriority: "high" as const } : {})}
            referrerPolicy="no-referrer"
            sizes={IMAGE_SIZES}
          />
        </div>
        <div className={styles.info}>
          {item.badgeLabel ? <span className={styles.badge}>{item.badgeLabel}</span> : null}
          <h3 className={styles.title}>{title}</h3>
          {item.priceLabel || item.metaLabel ? (
            <p className={styles.meta}>
              {item.priceLabel ? <span className={styles.price}>{item.priceLabel}</span> : null}
              {item.metaLabel ? <span className={styles.stores}>{item.metaLabel}</span> : null}
            </p>
          ) : null}
        </div>
      </article>
    </li>
  );
}
