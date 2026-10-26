import type { ReactNode } from "react";
import { HOME_COPY } from "./home-copy.ts";
import styles from "./home-welcome.module.css";

export function HomeWelcome({ children }: { children: ReactNode }) {
  return (
    <div className={styles.welcome}>
      <div className={styles.intro}>
        <span className={styles.eyebrow}>
          <span aria-hidden="true">✦</span> Aradığın ürüne, kendi yolundan ulaş.
        </span>
        <h1 id="anasayfa-baslik" className={styles.title}>
          {HOME_COPY.heroTitleLead}
          <br />
          <span>{HOME_COPY.heroTitleAccent}</span>
        </h1>
        <p className={styles.description}>{HOME_COPY.heroSubtitle}</p>
      </div>
      <div className={styles.composer}>{children}</div>
      <ol className={styles.steps} aria-label="Nasıl çalışır?">
        <li>
          <span className={styles.number}>01</span>
          <div>
            <strong>Ne aradığını anlat</strong>
            <p>Bir ürün adı ya da aklındaki birkaç detay.</p>
          </div>
        </li>
        <li>
          <span className={styles.number}>02</span>
          <div>
            <strong>Seçenekleri karşılaştır</strong>
            <p>Aynı ve benzer ürünlere birlikte göz at.</p>
          </div>
        </li>
        <li>
          <span className={styles.number}>03</span>
          <div>
            <strong>İçine sineni seç</strong>
            <p>Mağaza tekliflerini incele, kararını ver.</p>
          </div>
        </li>
      </ol>
    </div>
  );
}
