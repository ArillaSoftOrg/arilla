import { joinClassNames } from "./layout.ts";
import styles from "./SearchConversationInput.module.css";

/**
 * Sonuclar gorunurken aramayi kendi cumlesiyle daraltma: "siyah olsun",
 * "5 bin lirayı geçmesin", "aslında modüler". Yeni bir arama degil, suren
 * konusmanin devamidir; yeni arama icin ust arama kutusu ayri durur.
 *
 * JS gerektirmez: GET formu, konusma durumunu gizli alanlarla tasir.
 */
export interface SearchConversationInputProps {
  id: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  action: string;
  inputName: string;
  hiddenFields: readonly { name: string; value: string }[];
  className?: string;
}

export function SearchConversationInput({
  id,
  label,
  placeholder,
  submitLabel,
  action,
  inputName,
  hiddenFields,
  className,
}: SearchConversationInputProps) {
  return (
    <form action={action} method="get" className={joinClassNames(styles.form, className)}>
      {hiddenFields.map((field, index) => (
        // Ayni ad birden fazla kez gelebilir (`n`); sira anlamlidir.
        // biome-ignore lint/suspicious/noArrayIndexKey: sirali, degismeyen gizli alanlar.
        <input key={`${field.name}:${index}`} type="hidden" name={field.name} value={field.value} />
      ))}
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.row}>
        <input
          id={id}
          type="text"
          name={inputName}
          placeholder={placeholder}
          className={styles.input}
          autoComplete="off"
          enterKeyHint="send"
          maxLength={120}
        />
        <button type="submit" className={styles.submit}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
