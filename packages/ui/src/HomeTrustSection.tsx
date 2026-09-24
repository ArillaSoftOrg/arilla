import styles from "./HomeTrustSection.module.css";

export interface TrustPoint {
  id: string;
  /** Kisa baslik (orn. "Mağazaları karşılaştır"). Istege bagli. */
  title?: string;
  text: string;
}

export interface HomeTrustSectionProps {
  title: string;
  /** h2'nin id'si - cagiran bolum `aria-labelledby` ile baglar. */
  headingId?: string;
  points: readonly TrustPoint[];
}

/**
 * Seffaflik bolumu. Sosyal kanit DEGIL - dogrulanmamis kullanici/magaza/
 * urun sayisi, "en buyuk", musteri yorumu yok. Yalnizca urunun gercekte
 * nasil calistigini ve sinirlarini anlatir (ayni/benzer bulma, magaza
 * karsilastirma, kaynakli ve zaman damgali fiyat, komisyon bildirimi).
 * Sakin, `--surface` zeminli tek panel; kartlar ve golge yok.
 */
export function HomeTrustSection({ title, headingId, points }: HomeTrustSectionProps) {
  return (
    <div className={styles.panel}>
      <h2 id={headingId} className={styles.title}>
        {title}
      </h2>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
      <ul role="list" className={styles.list}>
        {points.map((point) => (
          <li key={point.id} className={styles.item}>
            {point.title ? <h3 className={styles.itemTitle}>{point.title}</h3> : null}
            <p className={styles.itemText}>{point.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
