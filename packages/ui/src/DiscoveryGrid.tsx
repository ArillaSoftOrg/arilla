import { DiscoveryCard, type DiscoveryItem } from "./DiscoveryCard.tsx";
import styles from "./DiscoveryGrid.module.css";
import { joinClassNames, listRole } from "./layout.ts";

export interface DiscoveryGridProps {
  items: readonly DiscoveryItem[];
  /** Listeyi adlandiran gorunur basligin id'si (tercih edilen). */
  labelledBy?: string;
  /** Gorunur baslik yoksa erisilebilir ad. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Kesif masonry izgarasi - ana sayfa `#kesfet` ve `/kesfet` ayni izgarayi
 * ve ayni `DiscoveryCard`'i kullanir (tek kart + tek izgara).
 *
 * Duzen karari: CSS multi-column (`column-count` 2 / 3 / 4 / 5, yalnizca
 * 640 / 1024 / 1440 noktalari). Kartlar kendi gercek gorsel oraninda
 * durdugu icin yukseklikleri farklidir; multi-column bunu JS'siz, bosluksuz
 * paketler. `grid-template-rows: masonry` henuz yaygin degil; satir-span'li
 * CSS grid ise akiskan sutun genisliginde gorsel oranini tam sayi satira
 * cevirmeyi gerektirir (JS veya olcum).
 *
 * Bedeli: DOM (okuma/sekme) sirasi sutun sutun ilerler. Kesif akisi
 * siralamasi anlam tasimayan bir urun listesidir; `ul` ekran okuyucuya
 * oge sayisini soyler, bagli kartlarda sekme sirasi DOM'u izler ve her
 * odak halkasi gorunurdur (WCAG 2.4.3 anlam/islevi korur). Baglantisi
 * olmayan (demo) kartlar odak almaz.
 */
export function DiscoveryGrid({ items, labelledBy, ariaLabel, className }: DiscoveryGridProps) {
  if (items.length === 0) return null;

  return (
    <ul
      // `list-style: none` WebKit'te liste rolunu dusurur; rol acikca verilir.
      role={listRole("ul", undefined)}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      className={joinClassNames(styles.grid, className)}
    >
      {items.map((item) => (
        <li key={item.id} className={styles.item}>
          <DiscoveryCard {...item} />
        </li>
      ))}
    </ul>
  );
}
