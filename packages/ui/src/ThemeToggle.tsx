import styles from "./ThemeToggle.module.css";

export interface ThemeToggleProps {
  /** null: cihaz tercibi takip ediliyor (henuz elle secim yok). */
  current: "light" | "dark" | null;
  onToggle: (next: "light" | "dark") => void;
}

/**
 * Framework'ten bagimsiz: cerez yazma islemi burada yapilmaz, cagiran
 * uygulama (`apps/web`) saglar. Karar 0007: tercih cereze yazilir.
 */
export function ThemeToggle({ current, onToggle }: ThemeToggleProps) {
  const next = current === "dark" ? "light" : "dark";
  const label = next === "dark" ? "Koyu temaya geç" : "Açık temaya geç";

  return (
    <button type="button" className={styles.toggle} onClick={() => onToggle(next)}>
      {label}
    </button>
  );
}
