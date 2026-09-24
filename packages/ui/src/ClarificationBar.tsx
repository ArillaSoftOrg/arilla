import styles from "./ClarificationBar.module.css";

export interface ClarificationCandidate {
  label: string;
  href: string;
}

export interface ClarificationBarProps {
  intro: string;
  candidates: readonly ClarificationCandidate[];
  otherLabel: string;
  otherPlaceholder: string;
  /** "başka bir şey" serbest metin girişinin gonderecegi form aksiyonu. */
  searchAction: string;
  queryParamName: string;
}

/**
 * docs/search.md "Netleştirme": sonuçları beklemez, üstte tek dokunuşluk
 * secenek olarak durur. "başka bir şey" her netleştirmede bulunur - JS
 * gerektirmeden her zaman görünür bir mini form olarak.
 */
export function ClarificationBar({
  intro,
  candidates,
  otherLabel,
  otherPlaceholder,
  searchAction,
  queryParamName,
}: ClarificationBarProps) {
  return (
    <section className={styles.bar} aria-label={intro}>
      <p className={styles.intro}>{intro}</p>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit'te liste rolunu dusurur. */}
      <ul className={styles.candidates} role="list">
        {candidates.map((candidate) => (
          <li key={candidate.href} className={styles.item}>
            <a href={candidate.href} className={styles.candidate}>
              {candidate.label}
            </a>
          </li>
        ))}
      </ul>
      <form action={searchAction} method="get" className={styles.otherForm}>
        <input
          type="text"
          name={queryParamName}
          placeholder={otherPlaceholder}
          aria-label={otherLabel}
          className={styles.otherInput}
        />
        <button type="submit" className={styles.candidate}>
          {otherLabel}
        </button>
      </form>
    </section>
  );
}
