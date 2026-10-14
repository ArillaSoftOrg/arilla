import type { MetricRow, Section, UmamiErrorKind } from "@arilla/core";
import { TRAFFIC_SMALL_CELL_MIN } from "@arilla/core";
import styles from "../admin.module.css";
import { DataTable, EmptyPanel, Notice } from "../admin-ui.tsx";
import { formatCount, formatDateTime } from "../format.ts";

const ERROR_LABELS: Record<UmamiErrorKind, string> = {
  timeout: "Umami zamanında yanıt vermedi.",
  network: "Umami'ye ulaşılamadı.",
  unauthorized: "Umami API anahtarı reddedildi; anahtarı yenile.",
  not_found: "Umami web sitesi bulunamadı; UMAMI_WEBSITE_ID'yi denetle.",
  rate_limited: "Umami istek sınırına takıldı; biraz sonra tekrar dene.",
  http: "Umami hata döndürdü.",
  too_large: "Umami yanıtı beklenenden büyük.",
  invalid_response: "Umami beklenmeyen biçimde yanıt verdi.",
};

export function umamiErrorLabel(kind: UmamiErrorKind): string {
  return ERROR_LABELS[kind] ?? "Umami verisi alınamadı.";
}

/** Bölüm hatası ya da eski veri bildirimi; başarılı taze veride `null`. */
export function SectionNotice<T>({ section }: { section: Section<T> | null | undefined }) {
  if (!section) return null;
  if (!section.ok) {
    return (
      <Notice tone="warning" title="Veri alınamadı">
        {umamiErrorLabel(section.error)} Site ve kısa bağlantılar etkilenmez.
      </Notice>
    );
  }
  if (section.stale) {
    return (
      <Notice tone="info" title="Eski veri">
        Umami şu an yanıt vermiyor; son iyi veri
        {section.storedAt ? ` (${formatDateTime(new Date(section.storedAt))})` : ""} gösteriliyor.
      </Notice>
    );
  }
  return null;
}

/**
 * Küçük hücreler (< `TRAFFIC_SMALL_CELL_MIN`) "Diğer"e katılır: az sayıda ziyaretçiden oluşan
 * ülke/cihaz/tarayıcı satırları tek kişiyi ele vermesin (GA4 trafik ekranıyla aynı eşik).
 */
export function foldSmall(rows: readonly MetricRow[]): MetricRow[] {
  const kept = rows.filter((row) => row.value >= TRAFFIC_SMALL_CELL_MIN);
  const rest = rows.filter((row) => row.value < TRAFFIC_SMALL_CELL_MIN);
  const folded = rest.reduce((sum, row) => sum + row.value, 0);
  return folded > 0 ? [...kept, { label: "Diğer", value: folded }] : kept;
}

export function MetricTable({
  section,
  firstHeader,
  valueHeader,
  fold = false,
  labelOf,
}: {
  section: Section<MetricRow[]> | undefined;
  firstHeader: string;
  valueHeader: string;
  fold?: boolean;
  labelOf?: (label: string) => string;
}) {
  if (!section) return null;
  if (!section.ok) return <SectionNotice section={section} />;
  const rows = fold ? foldSmall(section.value) : section.value;
  return (
    <>
      <SectionNotice section={section} />
      <DataTable<MetricRow>
        rows={rows}
        rowKey={(row) => row.label || "(bilinmiyor)"}
        stack
        empty={<EmptyPanel title="Bu dönemde veri yok" />}
        columns={[
          {
            key: "label",
            header: firstHeader,
            cell: (row) => (
              <span className={styles.mono}>
                {row.label === "" ? "(doğrudan / bilinmiyor)" : (labelOf?.(row.label) ?? row.label)}
              </span>
            ),
          },
          {
            key: "value",
            header: valueHeader,
            numeric: true,
            cell: (row) => formatCount(row.value),
          },
        ]}
      />
    </>
  );
}

/** `2026-03-10` → `10.03.2026`; saat varsa `10.03 14:00`. Tanınmayan biçim aynen. */
export function umamiLabel(label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(label);
  if (!match) return label;
  const [, y, m, d, hh, mm] = match;
  if (hh && mm && !(hh === "00" && mm === "00")) return `${d}.${m} ${hh}:${mm}`;
  return `${d}.${m}.${y}`;
}
