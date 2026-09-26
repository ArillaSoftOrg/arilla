import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./admin.module.css";
import { statusLabel } from "./format.ts";

/** /yonetim ortak sunucu bileşenleri. Tümü düz metin render eder; ham HTML yok. */

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className={styles.pageHeader}>
      <h1 className={styles.pageTitle}>{title}</h1>
      {children}
    </header>
  );
}

export function Tile({
  label,
  value,
  note,
  warning = false,
}: {
  label: string;
  value: string;
  note?: string;
  warning?: boolean;
}) {
  return (
    <div className={warning ? `${styles.tile} ${styles.tileWarning}` : styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note ? <span className={styles.tileNote}>{note}</span> : null}
    </div>
  );
}

/** İmleç ya da sayfa bağlantıları. Toplam sayı gösterilmez (COUNT çalıştırılmaz). */
export function Pager({
  first,
  prev,
  next,
  label,
  nextLabel = "Sonraki",
}: {
  first?: string | null;
  prev?: string | null;
  next?: string | null;
  label?: string;
  nextLabel?: string;
}) {
  if (!first && !prev && !next) return null;
  return (
    <nav className={styles.pager} aria-label="Sayfalar">
      {first ? <Link href={first}>En yeniye dön</Link> : null}
      {prev ? <Link href={prev}>Önceki</Link> : null}
      {label ? <span className={styles.meta}>{label}</span> : null}
      {next ? <Link href={next}>{nextLabel}</Link> : null}
    </nav>
  );
}

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className={styles.keyValues}>
      {items.map(([key, value]) => (
        <div key={key} style={{ display: "contents" }}>
          <dt>{key}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

const BAD = new Set(["failed", "rejected_moderation", "rejected"]);
const WARN = new Set(["partial", "running", "queued", "processing", "pending"]);

export function StatusText({ status }: { status: string }) {
  const className = BAD.has(status)
    ? styles.statusBad
    : WARN.has(status)
      ? styles.statusWarn
      : styles.statusGood;
  return <span className={className}>{statusLabel(status)}</span>;
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.pageHeader} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
      {children}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className={styles.notice}>{children}</p>;
}
