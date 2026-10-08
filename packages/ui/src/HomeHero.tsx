import type { CSSProperties, ReactNode } from "react";
import styles from "./HomeHero.module.css";

export interface HomeHeroProps {
  /** h1'in vurgusuz ilk parcasi. */
  titleLead: string;
  /** h1'in hafifce vurgulanan son parcasi (marka adi). */
  titleAccent: string;
  /**
   * Basligin altinda sirayla beliren tek satirlik cumleler. Hepsi ayni
   * hucrede ust uste durur (yukseklik en uzunundan gelir, yer kaymaz);
   * gecis saf CSS ve dongu tam 4 cumle icin ayarli (HomeHero.module.css).
   * Ilki hareketsiz kullanicida tek basina gorunur.
   */
  rotatingLines: readonly string[];
  /** h1'in id'si - cagiran bolum `aria-labelledby` ile baglar. */
  titleId?: string;
  /** Hero'nun ana eylemi (ana sayfada arama kutusu); basligin altinda. */
  children?: ReactNode;
}

/**
 * docs/pages.md "/": kisa, guclu baslik + donen tek satir + arama.
 * Display rolu sayfada yalnizca burada kullanilir (design.md "Tip rolleri").
 * Masaustunde ortali, okuma genisliginde; mobilde tam genislik.
 */
export function HomeHero({
  titleLead,
  titleAccent,
  rotatingLines,
  titleId,
  children,
}: HomeHeroProps) {
  return (
    <div className={styles.hero}>
      <div className={styles.intro}>
        <h1 id={titleId} className={styles.title}>
          <span className={styles.titleLead}>{titleLead}</span>{" "}
          <span className={styles.titleAccent}>{titleAccent}</span>
        </h1>
        <p className={styles.rotator}>
          {rotatingLines.map((line, index) => (
            <span
              key={line}
              className={styles.rotatorLine}
              style={{ "--line-index": index } as CSSProperties}
              // Yardimci teknolojiler tekrar eden dort cumle yerine yalnizca ilkini okur.
              aria-hidden={index === 0 ? undefined : true}
            >
              {line}
            </span>
          ))}
        </p>
      </div>
      {children ? <div className={styles.action}>{children}</div> : null}
    </div>
  );
}
