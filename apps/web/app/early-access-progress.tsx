import type { EarlyAccessProgress as Progress } from "@arilla/core";
import { EARLY_ACCESS_COPY } from "./early-access-copy.ts";
import styles from "./early-access-progress.module.css";

const NUMBER = new Intl.NumberFormat("tr-TR");

/**
 * Erken erişim ilerleme çubuğu (karar 0065). Yalnızca sunucuda hesaplanmış
 * gerçek sayı: platform dışı gerçek başvurular + gerçek kayıtlar. İstemci
 * betiği yok; ekran okuyucu için `progressbar` rolü ve metin karşılığı var.
 */
export function EarlyAccessProgress({ progress }: { progress: Progress }) {
  const label = EARLY_ACCESS_COPY.progressLabel;
  return (
    <div className={styles.root}>
      <p className={styles.label}>{label}</p>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={progress.target}
        aria-valuenow={progress.count}
        aria-valuetext={EARLY_ACCESS_COPY.progressValueText(
          NUMBER.format(progress.count),
          NUMBER.format(progress.target),
        )}
      >
        <span className={styles.fill} style={{ inlineSize: `${progress.percent}%` }} />
      </div>
      <p className={styles.value}>
        <strong>{NUMBER.format(progress.count)}</strong> / {NUMBER.format(progress.target)}{" "}
        {EARLY_ACCESS_COPY.progressUnit}
      </p>
    </div>
  );
}
