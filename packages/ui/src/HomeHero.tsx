import type { ReactNode } from "react";
import styles from "./HomeHero.module.css";

export interface HomeHeroProps {
  title: string;
  subtitle: string;
  /** h1'in id'si - cagiran bolum `aria-labelledby` ile baglar. */
  titleId?: string;
  /** Hero'nun ana eylemi (ana sayfada arama kutusu); basligin altinda. */
  children?: ReactNode;
}

/**
 * docs/pages.md "/": kisa, guclu baslik + tek satir deger onerisi + arama.
 * Display rolu sayfada yalnizca burada kullanilir (design.md "Tip rolleri").
 * Masaustunde ortali, okuma genisliginde; mobilde tam genislik.
 */
export function HomeHero({ title, subtitle, titleId, children }: HomeHeroProps) {
  return (
    <div className={styles.hero}>
      <div className={styles.intro}>
        <h1 id={titleId} className={styles.title}>
          {title}
        </h1>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
      {children ? <div className={styles.action}>{children}</div> : null}
    </div>
  );
}
