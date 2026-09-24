import styles from "./home-section-heading.module.css";

/**
 * Public kesif bolumlerinin (ana sayfa, `/kesfet`) ortak bolum basligi:
 * h2 (`--text-h2`) + kisa aciklama (`--ink-secondary`). Sayfa basligi
 * gerektiginde `level={1}` ile `--text-h1` rolunde h1 olur.
 */
export function HomeSectionHeading({
  id,
  title,
  description,
  level = 2,
}: {
  id: string;
  title: string;
  description?: string;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className={styles.heading}>
      <Heading id={id} className={level === 1 ? styles.titleH1 : styles.title}>
        {title}
      </Heading>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
  );
}
