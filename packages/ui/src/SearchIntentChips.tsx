import { joinClassNames } from "./layout.ts";
import styles from "./SearchIntentChips.module.css";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

/**
 * Konusmali aramada Arilla'nin ne anladigini gosteren kompakt cipler
 * (docs/decisions/0030): "Kapalı (full face) ×", "En fazla 5.000 TL ×".
 * Etiketler taksonomiden gelir; ic alan adlari veya ham durum gosterilmez.
 *
 * Erisilebilirlik:
 * - Liste bir baslikla (gorunur) etiketlenir.
 * - Kaldirma bir `<a>`'dir: JS olmadan calisir; gizli metni hangi
 *   filtrenin kaldirildigini soyler ("Kapalı (full face) filtresini kaldır").
 * - Kaldirilamayan cip (ilk sorgudan gelen renk gibi) duz metindir.
 * - Odak halkasi tum cipi cevreler; "×" etiket metninin ustune binmez.
 *
 * Ayni bilesen iki anlamda kullanilir ve baslik bunu ayirir: aramayi
 * gercekten degistirenler ("Aramada kullanılanlar") ve yalnizca sonraki
 * soruyu belirleyen tercihler ("Tercihlerin"). Ikincisi filtre gibi
 * adlandirilmaz (`removeLabelSuffix`).
 */

export interface SearchIntentChip {
  key: string;
  label: string;
  /** Yoksa cip yalnizca gosterilir. */
  removeHref?: string | null;
}

export interface SearchIntentChipsProps {
  headingId: string;
  heading: string;
  chips: readonly SearchIntentChip[];
  /** Kaldirma baglantisinin gizli metni: "<etiket> filtresini kaldır". */
  removeLabelSuffix?: string;
  className?: string;
}

export function SearchIntentChips({
  headingId,
  heading,
  chips,
  removeLabelSuffix = "filtresini kaldır",
  className,
}: SearchIntentChipsProps) {
  if (chips.length === 0) return null;
  return (
    <section className={joinClassNames(styles.root, className)} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {heading}
      </h2>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit'te liste rolunu dusurur. */}
      <ul className={styles.chips} role="list">
        {chips.map((chip) => (
          <li key={chip.key} className={styles.chip}>
            <span className={styles.label}>{chip.label}</span>
            {chip.removeHref ? (
              <a href={chip.removeHref} className={styles.remove}>
                <span aria-hidden="true">×</span>
                <VisuallyHidden>{`${chip.label} ${removeLabelSuffix}`}</VisuallyHidden>
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
