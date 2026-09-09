import styles from "./UpdatedAt.module.css";

export interface UpdatedAtProps {
  /** docs/copy.md `product.updated_at`: "{süre} önce güncellendi". */
  text: string;
}

export function UpdatedAt({ text }: UpdatedAtProps) {
  return <p className={styles.text}>{text}</p>;
}
