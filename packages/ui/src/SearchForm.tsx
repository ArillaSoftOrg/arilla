import { Button } from "./Button.tsx";
import styles from "./SearchForm.module.css";

export interface SearchFormProps {
  /** docs/routes.md: "/ara?q=..." */
  action?: string;
  name?: string;
  defaultValue?: string;
  placeholder: string;
  submitLabel: string;
  /** docs/pages.md "/": "Otomatik odaklanır." Yalnızca ana sayfada true olmalı - /ara'da her navigasyonda sonuçlardan odağı çalardı. */
  autoFocus?: boolean;
}

/**
 * JS'siz calisir (native GET form) - docs/pages.md "Arama girdisi": ana
 * sayfa ve /ara'da ayni bilesen. D1'in `Input`'unu kullanmaz cunku bu
 * girdi gorunur etiket degil placeholder tasir (arama kutusu deseni).
 * Gorunum ana sayfa composer'inin kompakt karsiligi: tek kutu, icinde
 * kenarliksiz girdi ve notr birincil eylem.
 */
export function SearchForm({
  action = "/ara",
  name = "q",
  defaultValue,
  placeholder,
  submitLabel,
  autoFocus = false,
}: SearchFormProps) {
  return (
    <form action={action} method="get" className={styles.form}>
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
        enterKeyHint="search"
        // biome-ignore lint/a11y/noAutofocus: opt-in prop, sadece ana sayfada true - docs/pages.md gereksinimi.
        autoFocus={autoFocus}
        className={styles.input}
      />
      <Button type="submit" variant="accent" shape="pill" className={styles.submit}>
        {submitLabel}
      </Button>
    </form>
  );
}
