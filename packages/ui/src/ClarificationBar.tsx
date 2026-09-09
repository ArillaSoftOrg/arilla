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
    <div className={styles.bar}>
      <span className={styles.intro}>{intro}</span>
      {candidates.map((candidate) => (
        <a key={candidate.href} href={candidate.href} className={styles.candidate}>
          {candidate.label}
        </a>
      ))}
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
    </div>
  );
}
