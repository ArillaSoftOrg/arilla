import styles from "./ClarificationQuestion.module.css";
import { joinClassNames } from "./layout.ts";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

/**
 * Konusmali netlestirme sorusu (docs/decisions/0030). `@arilla/core`'daki
 * `ClarificationQuestion` sozlesmesinin gorunumu; uygulama her secenek icin
 * bir sonraki adimin linkini (`href`) kendisi kurar.
 *
 * Erisilebilirlik sozlesmesi:
 * - Soru gercek bir basliktir; bolum ona `aria-labelledby` ile baglanir.
 * - Secenekler dogal `<a>` ogeleridir: JS olmadan calisir, Tab ile gezilir,
 *   Enter ile secilir. Dokunma hedefi en az `--size-touch-target`.
 * - Secili durum yalnizca renkle gosterilmez: onay isareti + kalin yazi +
 *   `aria-current` + ekran okuyucu icin "seçili" metni.
 * - Atlama secenegi kesik cizgili kenarla ayrisir (renk degil bicim).
 * - Secenekler dar ekranda satir kirar; yatay kaydirma yok.
 */

export interface ClarificationOptionView {
  id: string;
  label: string;
  href: string;
  selected?: boolean;
}

export interface ClarificationQuestionProps {
  /** Baslik kimligi; sayfada benzersiz olmali. */
  headingId: string;
  question: string;
  headingLevel?: 2 | 3;
  options: readonly ClarificationOptionView[];
  /** "Fark etmez" / "Emin değilim". Her soruda bulunur. */
  skip: { label: string; href: string };
  /** "Sonuçları göster": kalan sorulari atlar. */
  showResults?: { label: string; href: string };
  /** Serbest metin: seceneklerde olmayan bir cevap icin. */
  freeText?: {
    label: string;
    placeholder: string;
    action: string;
    inputName: string;
    submitLabel: string;
    /** Konusma durumunu tasiyan gizli alanlar (`q`, `n`). */
    hiddenFields: readonly { name: string; value: string }[];
  };
  className?: string;
}

export function ClarificationQuestion({
  headingId,
  question,
  headingLevel = 2,
  options,
  skip,
  showResults,
  freeText,
  className,
}: ClarificationQuestionProps) {
  const Heading = `h${headingLevel}` as const;
  const inputId = `${headingId}-serbest`;
  return (
    <section className={joinClassNames(styles.panel, className)} aria-labelledby={headingId}>
      <Heading id={headingId} className={styles.question}>
        {question}
      </Heading>

      {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit'te liste rolunu dusurur. */}
      <ul className={styles.options} role="list">
        {options.map((option) => (
          <li key={option.id} className={styles.item}>
            <a
              href={option.href}
              className={joinClassNames(styles.option, option.selected && styles.selected)}
              aria-current={option.selected ? "true" : undefined}
            >
              {option.selected ? (
                <span className={styles.check} aria-hidden="true">
                  ✓
                </span>
              ) : null}
              {option.label}
              {option.selected ? <VisuallyHidden> (seçili)</VisuallyHidden> : null}
            </a>
          </li>
        ))}
        <li className={styles.item}>
          <a href={skip.href} className={joinClassNames(styles.option, styles.skip)}>
            {skip.label}
          </a>
        </li>
      </ul>

      {freeText ? (
        <form action={freeText.action} method="get" className={styles.freeText}>
          {freeText.hiddenFields.map((field) => (
            <input
              key={`${field.name}:${field.value}`}
              type="hidden"
              name={field.name}
              value={field.value}
            />
          ))}
          <label htmlFor={inputId} className={styles.freeTextLabel}>
            {freeText.label}
          </label>
          <div className={styles.freeTextRow}>
            <input
              id={inputId}
              type="text"
              name={freeText.inputName}
              placeholder={freeText.placeholder}
              className={styles.input}
              autoComplete="off"
            />
            <button type="submit" className={styles.option}>
              {freeText.submitLabel}
            </button>
          </div>
        </form>
      ) : null}

      {showResults ? (
        <a href={showResults.href} className={styles.showResults}>
          {showResults.label}
        </a>
      ) : null}
    </section>
  );
}
