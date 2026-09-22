import type { ReactNode } from "react";
import styles from "./HowItWorksCard.module.css";

export interface HowItWorksStep {
  id: string;
  /** Dekoratif sira numarasi ("01" gibi) - aria-hidden, ic gorunum sirasi zaten DOM/heading ile verilir. */
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
 * docs/pages.md "/" Faz 4: "Nasıl Çalışır" adimi karti. Basit bilgi karti -
 * interactive degil, CTA yok (gorev talimati: dead CTA olusturulmaz).
 */
export function HowItWorksCard({
  number,
  title,
  description,
  icon,
  statusLabel,
}: HowItWorksCardProps) {
  return (
    <article className={styles.card}>
      <span className={styles.number} aria-hidden="true">
        {number}
      </span>
      <div className={styles.icon}>{icon}</div>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{description}</p>
      {statusLabel ? <p className={styles.status}>{statusLabel}</p> : null}
    </article>
  );
}
