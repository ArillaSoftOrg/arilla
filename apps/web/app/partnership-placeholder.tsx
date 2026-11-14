import styles from "./partnership-placeholder.module.css";

export function PartnershipPlaceholder({ title }: { title: string }) {
  return (
    <article className={styles.page}>
      <p className={styles.eyebrow}>İş Ortaklıkları</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.status}>Bu sayfa geliştirilme aşamasında.</p>
    </article>
  );
}
