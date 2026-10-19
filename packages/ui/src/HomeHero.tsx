import type { ReactNode } from "react";
import styles from "./HomeHero.module.css";

export interface HomeHeroProps {
  /** Basligin ilk satiri. */
  titleLead: string;
  /** Basligin ikinci, tamamlayici satiri. */
  titleAccent: string;
  /** h1'in id'si - cagiran bolum `aria-labelledby` ile baglar. */
  titleId?: string;
  /** Hero'nun ana eylemi (ana sayfada arama kutusu); basligin altinda. */
  children?: ReactNode;
}

/**
 * docs/pages.md "/": kisa baslik + ana arama.
 * Display rolu sayfada yalnizca burada kullanilir (design.md "Tip rolleri").
 * Masaustunde ortali, okuma genisliginde; mobilde tam genislik.
 */
export function HomeHero({ titleLead, titleAccent, titleId, children }: HomeHeroProps) {
  return (
    <div className={styles.hero}>
      <div className={styles.intro}>
        <h1 id={titleId} className={styles.title}>
          <span className={styles.titleLead}>{titleLead}</span>
          <span className={styles.titleAccent}>{titleAccent}</span>
        </h1>
      </div>
      {children ? <div className={styles.action}>{children}</div> : null}
    </div>
  );
}
