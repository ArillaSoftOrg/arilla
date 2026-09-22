import styles from "./HomeTrustSection.module.css";

export interface TrustPoint {
  id: string;
  text: string;
}

export interface HomeTrustSectionProps {
  title: string;
  points: readonly TrustPoint[];
}

/**
 * docs/pages.md "/" Faz 5: sosyal kanit DEGIL - dogrulanmamis kullanici/
 * magaza sayisi, "en ucuz fiyat garantisi" gibi iddia YOK. Sadece gercek,
 * zamansiz kabiliyetler (gorev talimati). Sakin/ikincil - TrendCollectionCard/
 * DiscoveryCard gibi karar 0025 istisnasi kullanmaz, duz metin listesi.
 */
export function HomeTrustSection({ title, points }: HomeTrustSectionProps) {
  return (
    <div className={styles.wrapper}>
      <h2 id="trust-heading" className={styles.title}>
        {title}
      </h2>
      <ul className={styles.list}>
        {points.map((point) => (
          <li key={point.id} className={styles.item}>
            {point.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
