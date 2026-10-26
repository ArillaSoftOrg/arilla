import Image from "next/image";
import type { ReactNode } from "react";
import { HOME_COPY } from "./home-copy.ts";
import styles from "./home-welcome.module.css";

const IDEAS = [
  {
    title: "Günlük favoriler",
    detail: "Sade, rahat, her güne uygun.",
    query: "beyaz günlük spor ayakkabı",
    position: "first",
  },
  {
    title: "Hafif adımlar",
    detail: "Yürüyüşe eşlik eden seçenekler.",
    query: "gri yürüyüş ayakkabısı",
    position: "second",
  },
  {
    title: "Doğal tonlar",
    detail: "Krem ve bej sneaker fikirleri.",
    query: "krem spor ayakkabı",
    position: "third",
  },
] as const;

export function HomeWelcome({ children }: { children: ReactNode }) {
  return (
    <div className={styles.welcome}>
      <div className={styles.searchArea}>
        <div className={styles.intro}>
          <span className={styles.eyebrow}>
            <span aria-hidden="true">✦</span> Alışverişe biraz keşif kat.
          </span>
          <h1 id="anasayfa-baslik" className={styles.title}>
            {HOME_COPY.heroTitleLead}
            <br />
            <span>{HOME_COPY.heroTitleAccent}</span>
          </h1>
          <p className={styles.description}>{HOME_COPY.heroSubtitle}</p>
        </div>
        <div className={styles.composer}>{children}</div>
      </div>
      <figure className={styles.visual} aria-label="Aramaya başlamak için ürün fikirleri">
        <div className={styles.visualHeader}>
          <span>Keşif defteri</span>
          <a href="/kesfet">
            Keşfet <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className={styles.visualGrid}>
          {IDEAS.map((idea, index) => (
            <a
              key={idea.position}
              className={`${styles.idea} ${styles[idea.position]}`}
              href={`/ara?q=${encodeURIComponent(idea.query)}`}
            >
              <div className={styles.imageWindow} aria-hidden="true">
                <Image
                  src="/coming-soon-shoes.png"
                  alt=""
                  width={2172}
                  height={724}
                  sizes="(min-width: 1024px) 1000px, (min-width: 640px) 900px, 600px"
                  loading={index === 0 ? "eager" : "lazy"}
                  fetchPriority={index === 0 ? "high" : "auto"}
                  className={styles.shoeImage}
                />
              </div>
              <div className={styles.ideaCaption}>
                <div>
                  <strong>{idea.title}</strong>
                  <span>{idea.detail}</span>
                </div>
                <span className={styles.ideaArrow} aria-hidden="true">
                  ↗
                </span>
              </div>
            </a>
          ))}
        </div>
        <figcaption className={styles.visualNote}>
          Bir fikirden, birçok seçeneğe. Görseller temsili.
        </figcaption>
      </figure>
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
