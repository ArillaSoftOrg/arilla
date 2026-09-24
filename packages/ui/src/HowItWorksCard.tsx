import type { ReactNode } from "react";
import styles from "./HowItWorksCard.module.css";

export interface HowItWorksStep {
  id: string;
  /** Dekoratif sira numarasi ("01" gibi) - aria-hidden; sira DOM'dan gelir. */
  number: string;
  title: string;
  description: string;
  /** Zaten aria-hidden tasiyan bir ikon bileseni (bkz. icons.tsx). */
  icon: ReactNode;
  /** Henuz arama akisina baglanmamis yontemler icin - sahte CTA yerine
   * acikca "Yakinda" gibi zamansiz bir durum etiketi (bkz. docs/pages.md). */
  statusLabel?: string;
}

export type HowItWorksCardProps = HowItWorksStep;

/**
 * "Nasıl çalışır" adimi - kucuk, etkilesimsiz bilgi ogesi (CTA yok). Kart
 * yuzeyi/kenarligi yok: ikon rozeti + baslik + tek cumle. Durum etiketi
 * (orn. "Yakında") aktif olmayan yontemi durustce isaretler; o adim soluk
 * gosterilir.
 */
export function HowItWorksCard({
  number,
  title,
  description,
  icon,
  statusLabel,
}: HowItWorksCardProps) {
  return (
    <article className={statusLabel ? `${styles.step} ${styles.inactive}` : styles.step}>
      <div className={styles.head}>
        <span className={styles.icon}>{icon}</span>
        <span className={styles.number} aria-hidden="true">
          {number}
        </span>
      </div>
      <h3 className={styles.title}>{title}</h3>
      {/* DOM'da basliktan sonra (ekran okuyucu once adi duyar), gorselde sag ustte. */}
      {statusLabel ? <span className={styles.status}>{statusLabel}</span> : null}
      <p className={styles.description}>{description}</p>
    </article>
  );
}
