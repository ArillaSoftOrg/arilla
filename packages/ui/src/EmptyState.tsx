import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { joinClassNames } from "./layout.ts";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Baslik seviyesi. Verilmezse `<p>` (sayfanin baslik hiyerarsisine
   * karismaz); bolumun tek icerigiyse `2`/`3`, sayfanin tek icerigiyse (baska `<h1>` yoksa) `1`. */
  headingLevel?: 1 | 2 | 3;
  /** `default`: bolum icinde ferah; `compact`: liste/panel icinde sik. */
  tone?: "default" | "compact";
  /** Istege bagli ikon (dekoratif, `aria-hidden`); illustrasyon degil. */
  icon?: ReactNode;
  className?: string;
}

/** docs/design.md, "Boş durum": yönlendirme metni, illüstrasyon yok. */
export function EmptyState({
  title,
  description,
  action,
  headingLevel,
  tone = "default",
  icon,
  className,
}: EmptyStateProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div
      className={joinClassNames(styles.emptyState, tone === "compact" && styles.compact, className)}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Title className={styles.title}>{title}</Title>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
