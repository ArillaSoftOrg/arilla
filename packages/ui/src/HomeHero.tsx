import styles from "./HomeHero.module.css";

export interface HomeHeroProps {
  title: string;
  subtitle: string;
}

/** docs/pages.md "/": basit baslik + kisa aciklama, uzun karsilama metni yok. */
export function HomeHero({ title, subtitle }: HomeHeroProps) {
  return (
    <div className={styles.hero}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.subtitle}>{subtitle}</p>
    </div>
  );
}
