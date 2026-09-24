import { Button } from "@arilla/ui";
import styles from "./ara.module.css";

/**
 * docs/pages.md "/ara" Hata satırı: "Arama şu an çalışmıyor" + tekrar dene.
 * Hata sınırı sayfanın yerini aldığı için tek `<h1>` burada.
 */
export function SearchErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.status}>
      <h1 className={styles.statusTitle}>Arama şu an çalışmıyor.</h1>
      <p className={styles.statusText}>Birazdan tekrar dener misin?</p>
      <Button variant="accent" shape="pill" onClick={onRetry}>
        Tekrar dene
      </Button>
    </div>
  );
}
