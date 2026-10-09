import type { AdminFinding, Capability, Severity } from "@arilla/core";
import { ArrowRightIcon, EmptyState } from "@arilla/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./admin.module.css";
import { formatDateOrDash, severityLabel, statusLabel } from "./format.ts";

/**
 * /yonetim ortak sunucu bileşenleri (docs/decisions/0083). Tümü düz metin
 * render eder; ham HTML yok. Yeni modüller (AI, analitik, katalog, trend,
 * affiliate) sayfa düzenini bu bileşenlerle kurar; sayfaya özgü stil yalnızca
 * gerçekten özgü olan için yazılır.
 */

function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/* ----------------------------------------------------------------------- */
/* Sayfa düzeni                                                             */
/* ----------------------------------------------------------------------- */

/**
 * Sayfa başlığı: tek `<h1>`, isteğe bağlı açıklama ve sağda eylemler.
 * `children` başlığın altında akar (eski kullanım aynen çalışır).
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <h1 className={styles.pageTitle}>{title}</h1>
          {description ? <p className={styles.muted}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.pageHeadActions}>{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Başlıklı bölüm (kutusuz). Kutulu bölüm için `Panel`. */
export function Section({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.pageHeader} aria-labelledby={id}>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <h2 id={id} className={styles.sectionTitle}>
            {title}
          </h2>
          {description ? <p className={styles.muted}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.pageHeadActions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Kutulu bölüm: başlık şeridi + gövde (+ isteğe bağlı alt not). `flush`
 * gövdesi tablo olan panel içindir (tablo kenardan kenara).
 */
export function Panel({
  id,
  title,
  description,
  actions,
  footer,
  flush = false,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 id={id} className={styles.sectionTitle}>
            {title}
          </h2>
          {description ? <p className={styles.muted}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.pageHeadActions}>{actions}</div> : null}
      </div>
      <div className={cx(styles.panelBody, flush && styles.panelFlush)}>{children}</div>
      {footer ? <div className={styles.panelFoot}>{footer}</div> : null}
    </section>
  );
}

/* ----------------------------------------------------------------------- */
/* KPI kartları                                                             */
/* ----------------------------------------------------------------------- */

/**
 * Sayının nereden geldiği. Analitik/AI modüllerinde her kart bunu taşır
 * (karar 0082 kapsam kaydı): kullanıcı tam sayımla örneklemi karıştırmaz.
 */
export type DataBasisKind = "count" | "estimate" | "consent_sample" | "unmeasured" | "external";

const BASIS_LABEL: Record<DataBasisKind, string> = {
  count: "Tam sayım",
  estimate: "Tahmini",
  consent_sample: "Rızalı örneklem",
  unmeasured: "Ölçülmüyor",
  external: "Dış kaynak gerekli",
};

export function DataBasis({ kind }: { kind: DataBasisKind }) {
  return <span className={styles.basis}>{BASIS_LABEL[kind]}</span>;
}

export type KpiTone = "neutral" | "warning" | "critical";

/**
 * Tek sayı kartı. `href` verilirse kart, sorunu teşhis eden sayfaya gider
 * (karar 0051); bağlantı yalnızca izleyicinin açabildiği sayfaya verilir
 * (çağıran denetler, hedef sayfa yetkiyi ayrıca ister). `tone` uyarı/kritik
 * ise kenar rengi değişir ve `status` metni yazılır: renk tek başına anlam
 * taşımaz.
 */
export function KpiCard({
  label,
  value,
  note,
  tone = "neutral",
  status,
  basis,
  href,
}: {
  label: string;
  value: string;
  note?: string | null;
  tone?: KpiTone;
  status?: string | null;
  basis?: DataBasisKind;
  href?: string | null;
}) {
  const className = cx(
    styles.tile,
    tone === "warning" && styles.tileWarning,
    tone === "critical" && styles.tileCritical,
  );
  const body = (
    <>
      <span className={styles.tileHead}>
        <span className={styles.tileLabel}>{label}</span>
        {href ? (
          <span className={styles.tileArrow} aria-hidden="true">
            <ArrowRightIcon size={14} />
          </span>
        ) : null}
      </span>
      <span className={styles.tileValue}>{value}</span>
      {status ? <span className={styles.tileStatus}>{status}</span> : null}
      {note ? <span className={styles.tileNote}>{note}</span> : null}
      {basis ? <DataBasis kind={basis} /> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cx(className, styles.tileLink)}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

/** Eski ad (geriye uyum): `warning` → `tone="warning"`. */
export function Tile({
  label,
  value,
  note,
  warning = false,
  href,
}: {
  label: string;
  value: string;
  note?: string | null;
  warning?: boolean;
  href?: string | null;
}) {
  return (
    <KpiCard
      label={label}
      value={value}
      note={note}
      tone={warning ? "warning" : "neutral"}
      href={href}
    />
  );
}

/** Başlıklı kart ızgarası (ör. "Katalog", "Arama ve AI"). */
export function KpiGroup({
  title,
  label,
  children,
}: {
  title?: string;
  /** Başlık görünmüyorsa ekran okuyucu için ad. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.kpiGroup} aria-label={title ? undefined : label}>
      {title ? <h2 className={styles.kpiGroupTitle}>{title}</h2> : null}
      <div className={styles.tiles}>{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------------------- */
/* Tablo                                                                   */
/* ----------------------------------------------------------------------- */

export interface DataColumn<T> {
  key: string;
  header: string;
  /** Sayısal sütun sağa hizalanır ve tabular rakam kullanır. */
  numeric?: boolean;
  cell: (row: T) => ReactNode;
}

/**
 * Sunucuda çizilen tablo. `stack` verilirse 640px altında her satır etiketli
 * bir karta döner (yatay kaydırma yerine); verilmezse tablo yatay kayar.
 * Boş listede tablo yerine `empty` gösterilir.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  stack = false,
}: {
  columns: readonly DataColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  caption?: string;
  empty?: ReactNode;
  stack?: boolean;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyPanel title="Kayıt yok" />}</>;
  }
  return (
    <div className={styles.tableWrap}>
      <table className={cx(styles.table, stack && styles.tableStack)}>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric ? styles.num : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-label={column.header}
                  className={column.numeric ? styles.num : undefined}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Filtre, sayfalama, sekmeler                                              */
/* ----------------------------------------------------------------------- */

/**
 * GET filtre formu: değerler adres satırında durur (paylaşılabilir, geri
 * tuşu çalışır, tarayıcı deposu gerekmez). `resetHref` filtreleri temizler.
 */
export function FilterBar({
  action,
  children,
  submitLabel = "Uygula",
  resetHref,
  label = "Filtreler",
}: {
  action: string;
  children: ReactNode;
  submitLabel?: string;
  resetHref?: string | null;
  label?: string;
}) {
  return (
    <form
      action={action}
      method="get"
      className={cx(styles.filters, styles.filterBar)}
      aria-label={label}
    >
      {children}
      <div className={styles.filterActions}>
        <button type="submit">{submitLabel}</button>
        {resetHref ? <Link href={resetHref}>Temizle</Link> : null}
      </div>
    </form>
  );
}

/** Görünür etiketli filtre alanı (etiket her zaman görünür, design.md "Input"). */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: denetim `children` içinde (select/input).
    <label className={styles.filterField}>
      <span className={styles.filterLabel}>{label}</span>
      {children}
    </label>
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
      {first ? (
        <Link href={first} className={styles.pagerLink}>
          En yeniye dön
        </Link>
      ) : null}
      {prev ? (
        <Link href={prev} className={styles.pagerLink} rel="prev">
          Önceki
        </Link>
      ) : null}
      {label ? <span className={styles.meta}>{label}</span> : null}
      {next ? (
        <Link href={next} className={styles.pagerLink} rel="next">
          {nextLabel}
        </Link>
      ) : null}
    </nav>
  );
}

export interface TabItem {
  href: string;
  label: string;
  active: boolean;
  count?: number | null;
}

/** Adres tabanlı sekmeler (sunucu tarafı): etkin sekme `aria-current="page"`. */
export function Tabs({ items, label }: { items: readonly TabItem[]; label: string }) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cx(styles.tab, item.active && styles.tabActive)}
          aria-current={item.active ? "page" : undefined}
        >
          {item.label}
          {item.count != null ? <span className={styles.tabCount}>{item.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/* ----------------------------------------------------------------------- */
/* Durum                                                                    */
/* ----------------------------------------------------------------------- */

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

export type StatusTone = "critical" | "warning" | "success" | "info" | "neutral";

const TONE_CLASS: Record<StatusTone, string | undefined> = {
  critical: styles.toneCritical,
  warning: styles.toneWarning,
  success: styles.toneSuccess,
  info: styles.toneInfo,
  neutral: styles.toneNeutral,
};

/** Hap biçimli durum rozeti: nokta + metin. Renk tek başına anlam taşımaz. */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={cx(styles.status, TONE_CLASS[tone])}>{children}</span>;
}

const BAD = new Set(["failed", "rejected_moderation", "rejected"]);
const WARN = new Set([
  "partial",
  "running",
  "queued",
  "processing",
  "pending",
  "sending",
  "partially_failed",
]);

export function statusTone(status: string): StatusTone {
  if (BAD.has(status)) return "critical";
  if (WARN.has(status)) return "warning";
  return "neutral";
}

/** Koşu/istek durumu satır içi metin olarak (tablolarda yoğun). */
export function StatusText({ status }: { status: string }) {
  const className = BAD.has(status)
    ? styles.statusBad
    : WARN.has(status)
      ? styles.statusWarn
      : styles.statusGood;
  return <span className={className}>{statusLabel(status)}</span>;
}

/* ----------------------------------------------------------------------- */
/* Bildirim ve boş/yükleniyor durumları                                     */
/* ----------------------------------------------------------------------- */

export type NoticeTone = "info" | "success" | "warning" | "error";

const NOTICE_CLASS: Record<NoticeTone, string | undefined> = {
  info: undefined,
  success: styles.noticeSuccess,
  warning: styles.noticeWarning,
  error: styles.noticeError,
};

/**
 * Bildirim. Hata `role="alert"` (hemen okunur), başarı `role="status"`
 * (sırası gelince), bilgi ve uyarı rolsüz (sayfanın kalıcı parçası).
 */
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  const role = tone === "error" ? "alert" : tone === "success" ? "status" : undefined;
  return (
    <div className={cx(styles.notice, NOTICE_CLASS[tone])} role={role}>
      {title ? <strong className={styles.noticeTitle}>{title}</strong> : null}
      {children}
    </div>
  );
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p className={cx(styles.notice, styles.noticeError)} role="alert">
      {children}
    </p>
  );
}

/** Boş liste/panel: yönlendirme metni, illüstrasyon yok (design.md "Boş durum"). */
export function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.emptyPanel}>
      <EmptyState tone="compact" title={title} description={description} action={action} />
    </div>
  );
}

/** Yer tutucu blok (animasyonsuz). Ekran okuyucudan gizli; durum `aria-busy` ile söylenir. */
export function Skeleton({
  variant = "line",
  width,
}: {
  variant?: "line" | "title" | "value";
  width?: string;
}) {
  const variantClass =
    variant === "title"
      ? styles.skeletonTitle
      : variant === "value"
        ? styles.skeletonValue
        : styles.skeletonLine;
  return (
    <span
      className={cx(styles.skeleton, variantClass)}
      style={width ? { width } : undefined}
      aria-hidden="true"
    />
  );
}

/* ----------------------------------------------------------------------- */
/* Önem ve bulgular (karar 0052)                                            */
/* ----------------------------------------------------------------------- */

const SEVERITY_CLASS: Record<Severity, string | undefined> = {
  critical: styles.sevCritical,
  warning: styles.sevWarning,
  unknown: styles.sevUnknown,
  info: styles.sevInfo,
  healthy: styles.sevHealthy,
};

/** Ortak önem rozeti (karar 0052). Renk tek başına anlam taşımaz: metin de yazılır. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={cx(styles.sevBadge, SEVERITY_CLASS[severity])}>{severityLabel(severity)}</span>
  );
}

/**
 * Kısa uyarı listesi (genel bakış, karar 0084). Satır başına önem rozeti,
 * teşhis sayfasına giden başlık, kanıt zamanı ve tek satır bağlam. Bulgunun
 * TAMAMI (anlam, kanıt, "Ne yapmalı") aynı satırdaki "Ayrıntı" içinde durur;
 * hiçbir uyarı ya da öneri düşmez. Kritik olanlar tonlu zeminde (sıra core'da).
 * Bağlantı yalnızca izleyicinin açabildiği sayfaya verilir.
 */
export function AlertSummaryList({
  findings,
  allowed,
  empty = "Dikkat gerektiren bir şey yok.",
}: {
  findings: readonly AdminFinding[];
  allowed: ReadonlySet<Capability>;
  empty?: string;
}) {
  if (findings.length === 0) {
    return <p className={styles.muted}>{empty}</p>;
  }
  // Sıra core'dan gelir (`sortFindings`: önce kritik). Bu dosya istemci hata
  // sınırınca da yüklenir; core'dan yalnızca tip alınır.
  return (
    <ul className={styles.alertList}>
      {findings.map((finding) => {
        const href =
          finding.href && (!finding.capability || allowed.has(finding.capability))
            ? finding.href
            : null;
        return (
          <li
            key={finding.key}
            className={cx(
              styles.alertItem,
              finding.severity === "critical" && styles.alertCritical,
              finding.severity === "warning" && styles.alertWarning,
            )}
          >
            <div className={styles.alertHead}>
              <SeverityBadge severity={finding.severity} />
              {href ? (
                <Link href={href} className={styles.alertTitle}>
                  {finding.title}
                </Link>
              ) : (
                <span className={styles.alertTitle}>{finding.title}</span>
              )}
            </div>
            <p className={styles.alertMeta}>
              <span className={styles.alertContext}>{finding.evidence ?? finding.meaning}</span>
              {finding.evidenceAt ? (
                <span className={styles.alertTime}>{formatDateOrDash(finding.evidenceAt)}</span>
              ) : null}
            </p>
            <details className={styles.alertDetails}>
              <summary className={styles.alertSummary}>Ayrıntı ve önerilen adım</summary>
              <p>{finding.meaning}</p>
              {finding.evidence ? <p className={styles.meta}>{finding.evidence}</p> : null}
              <p>
                <strong>Ne yapmalı: </strong>
                {finding.action}
              </p>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Bulgu listesi (işletim, katalog kalitesi, dikkat). Bağlantı yalnızca
 * izleyicinin `allowed` yeteneklerinden biriyle açabildiği sayfaya verilir;
 * hedef sayfa yetkiyi ayrıca ister.
 */
export function FindingList({
  findings,
  allowed,
  empty = "Dikkat gerektiren bir şey yok.",
}: {
  findings: readonly AdminFinding[];
  allowed: ReadonlySet<Capability>;
  empty?: string;
}) {
  if (findings.length === 0) return <p className={styles.muted}>{empty}</p>;
  return (
    <ul className={styles.findings}>
      {findings.map((finding) => {
        const href =
          finding.href && (!finding.capability || allowed.has(finding.capability))
            ? finding.href
            : null;
        return (
          <li
            key={finding.key}
            className={cx(
              styles.finding,
              finding.severity === "critical" && styles.findingCritical,
              finding.severity === "warning" && styles.findingWarning,
            )}
          >
            <div className={styles.findingHead}>
              <SeverityBadge severity={finding.severity} />
              {href ? (
                <Link href={href} className={styles.findingTitle}>
                  {finding.title}
                </Link>
              ) : (
                <span className={styles.findingTitle}>{finding.title}</span>
              )}
              {finding.evidenceAt ? (
                <span className={styles.meta}>{formatDateOrDash(finding.evidenceAt)}</span>
              ) : null}
            </div>
            <p className={styles.findingText}>{finding.meaning}</p>
            {finding.evidence ? <p className={styles.meta}>{finding.evidence}</p> : null}
            <p className={styles.findingAction}>
              <strong>Ne yapmalı: </strong>
              {finding.action}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
