import { MoonIcon, SunIcon } from "./icons.tsx";
import styles from "./ThemeToggle.module.css";

export interface ThemeToggleProps {
  /** Dugmenin sabit erisilebilir adi (docs/copy.md `theme.toggle_label`). */
  label: string;
  /**
   * Koyu tema etkin mi (`aria-pressed`). `undefined`: henuz bilinmiyor
   * (sunucu cihaz tercihini bilemez); istemci baglaninca dolar.
   */
  pressed: boolean | undefined;
  onToggle: () => void;
}

/**
 * Karar 0092: ust cubuktaki kompakt acik/koyu tema dugmesi. Sunum bileseni;
 * tercih ve kalicilik cagiran tarafta (apps/web). Hangi ikonun gorunecegini
 * CSS etkin temadan (`<html data-theme>` ya da cihaz tercihi) secer, bu
 * yuzden ilk HTML'de de dogru ikon cizilir (JS beklenmez, titreme yok).
 */
export function ThemeToggle({ label, pressed, onToggle }: ThemeToggleProps) {
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onToggle}
    >
      <MoonIcon className={styles.moon} />
      <SunIcon className={styles.sun} />
    </button>
  );
}
