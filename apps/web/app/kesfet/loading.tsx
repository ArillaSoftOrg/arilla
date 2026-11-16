import { Section, VisuallyHidden } from "@arilla/ui";
import { HOME_COPY } from "../home-copy.ts";
import styles from "./discover.module.css";
import kesfet from "./kesfet.module.css";

/** Sabit, çeşitli oranlar (4:5, 1:1, 3:4, ...): gerçek veri uydurulmaz, yalnız yer tutucu. */
const RATIOS = ["4 / 5", "1 / 1", "3 / 4", "5 / 4", "4 / 5", "3 / 4", "1 / 1", "4 / 5"] as const;

/** Keşfet yükleniyor durumu: yeni masonry ile aynı sütun ve yarıçap. */
export default function KesfetLoading() {
  return (
    <div className={kesfet.page}>
      <Section aria-busy="true" aria-label={HOME_COPY.kesfetLoading}>
        <VisuallyHidden>{HOME_COPY.kesfetLoading}</VisuallyHidden>
        <ul className={styles.skeletonGrid} aria-hidden="true">
          {RATIOS.map((ratio, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sabit, sıralı yer tutucu listesi.
            <li key={index} className={styles.skeleton} style={{ aspectRatio: ratio }} />
          ))}
        </ul>
      </Section>
    </div>
  );
}
