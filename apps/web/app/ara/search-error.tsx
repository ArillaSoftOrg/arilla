import type { PublicError } from "@arilla/core/errors";
import { Button } from "@arilla/ui";
import { ErrorView } from "../error-view.tsx";
import styles from "./ara.module.css";

/**
 * docs/pages.md "/ara" Hata satırı: "Arama şu an çalışmıyor" + tekrar dene.
 * Hata sınırı sayfanın yerini aldığı için tek `<h1>` burada. Neden doğrulanmışsa
 * (`error.code !== "unknown"`) ya da referans kodu varsa ortak hata görünümü
 * (karar 0104) açıklama ve referansı gösterir; aksi hâlde eski sade metin.
 */
export function SearchErrorState({ onRetry, error }: { onRetry: () => void; error?: PublicError }) {
  return (
    <div className={styles.status}>
      <h1 className={styles.statusTitle}>Arama şu an çalışmıyor.</h1>
      {error && (error.code !== "unknown" || error.reference) ? (
        <ErrorView error={error} onRetry={onRetry} />
      ) : (
        <>
          <p className={styles.statusText}>Birazdan tekrar dener misin?</p>
          <Button variant="accent" shape="pill" onClick={onRetry}>
            Tekrar dene
          </Button>
        </>
      )}
    </div>
  );
}
