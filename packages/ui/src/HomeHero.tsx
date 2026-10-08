import type { ReactNode } from "react";
import styles from "./HomeHero.module.css";

export interface HomeHeroProps {
  /** Basligin ilk hali ("Alışveriş mi?"). */
  titleLead: string;
  /** Basligin ikinci hali (marka adi); ilkiyle ayni alanda dönüşümlü görünür. */
  titleAccent: string;
  /** Sabit tek satir alt metin. */
  subtitle: string;
  /** h1'in id'si - cagiran bolum `aria-labelledby` ile baglar. */
  titleId?: string;
  /** Hero'nun ana eylemi (ana sayfada arama kutusu); basligin altinda. */
  children?: ReactNode;
}

/**
 * docs/pages.md "/": donusumlu kisa baslik + sabit alt metin + arama.
 * Display rolu sayfada yalnizca burada kullanilir (design.md "Tip rolleri").
 * Iki baslik metni ayni grid hucresinde ust uste durur; gecis saf CSS.
 * Hareket istemeyen kullanici ikisini de yan yana, statik gorur.
 * Masaustunde ortali, okuma genisliginde; mobilde tam genislik.
 */
export function HomeHero({ titleLead, titleAccent, subtitle, titleId, children }: HomeHeroProps) {
  return (
    <div className={styles.hero}>
      <div className={styles.intro}>
        <h1 id={titleId} className={styles.title}>
          <span className={styles.titleLead}>{titleLead}</span>{" "}
          <span className={styles.titleAccent}>{titleAccent}</span>
        </h1>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
      {children ? <div className={styles.action}>{children}</div> : null}
    </div>
  );
}
