import {
  istanbulToday,
  listTrackingLinks,
  readAppUrl,
  resolveStatsRange,
  type TrackingLinkRow,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  FilterBar,
  FilterField,
  PageHeader,
  Panel,
  StatusBadge,
  Tabs,
} from "../admin-ui.tsx";
import { formatCount, formatDateTime, hrefWith } from "../format.ts";
import { CopyLinkButton } from "./link-actions-client.tsx";
import { LinkFormClient } from "./link-form-client.tsx";

const PATH = "/yonetim/takip-baglantilari";
const PRESETS = [
  { label: "Son 7 gün", days: 7 },
  { label: "Son 30 gün", days: 30 },
  { label: "Son 90 gün", days: 90 },
] as const;

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Takip bağlantıları (karar 0115, `links.read` / `links.manage`, yalnızca
 * yönetici). Tarih aralığı adres satırında (Istanbul takvim günü, dahil); geçersiz
 * ya da 366 günden uzun aralık son 30 güne düşer. Sayılar yalnızca tıklama
 * sayacıdır: ziyaretçi, kişi ya da cihaz verisi yoktur.
 */
export default async function TrackingLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { actor } = await requireCapability("links.read");
  const params = await searchParams;
  const range = resolveStatsRange({ from: params.from, to: params.to });
  const rows = await listTrackingLinks(getDatabase(), actor, { range });
  const origin = readAppUrl() ?? "";
  const today = istanbulToday();
  const activePreset = PRESETS.find(
    (preset) => range.to === today && range.from === shiftDay(today, -(preset.days - 1)),
  );
  const totalInRange = rows.reduce((sum, row) => sum + row.clicksInRange, 0);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Takip bağlantıları"
        description="Yönetimden oluşturulan kısa adresler. Yeni bağlantı deploy gerektirmeden hemen çalışır. Sayılar yalnızca tıklama sayacıdır; IP, cihaz ya da kişi bilgisi tutulmaz. Bot, ön yükleme ve HEAD istekleri sayılmaz."
        actions={
          <Tabs
            label="Tarih aralığı"
            items={PRESETS.map((preset) => ({
              href: hrefWith(PATH, {
                from: shiftDay(today, -(preset.days - 1)),
                to: today,
              }),
              label: preset.label,
              active: activePreset?.days === preset.days,
            }))}
          />
        }
      />

      <Panel
        id="aralik"
        title="Tarih aralığı"
        description={`${range.from} – ${range.to} (Europe/Istanbul, ${range.days} gün; en fazla 366 gün).`}
      >
        <FilterBar action={PATH} resetHref={PATH} label="Tarih aralığı">
          <FilterField label="Başlangıç">
            <input type="date" name="from" defaultValue={range.from} max={today} required />
          </FilterField>
          <FilterField label="Bitiş">
            <input type="date" name="to" defaultValue={range.to} max={today} required />
          </FilterField>
        </FilterBar>
      </Panel>

      <Panel
        id="liste"
        title="Bağlantılar"
        description={`${formatCount(rows.length)} bağlantı; seçili aralıkta toplam ${formatCount(totalInRange)} tıklama.`}
        actions={<DataBasis kind="count" />}
        flush={rows.length > 0}
      >
        <DataTable<TrackingLinkRow>
          rows={rows}
          rowKey={(row) => row.id}
          stack
          empty={<EmptyPanel title="Henüz takip bağlantısı yok" />}
          columns={[
            {
              key: "name",
              header: "Bağlantı",
              cell: (row) => (
                <span className={styles.list}>
                  <Link href={`${PATH}/${row.id}${rangeQuery(range)}`}>{row.name}</Link>
                  <span className={styles.meta}>{`/${row.slug}`}</span>
                </span>
              ),
            },
            {
              key: "target",
              header: "Hedef",
              cell: (row) => <span className={styles.mono}>{row.targetUrl}</span>,
            },
            {
              key: "utm",
              header: "Kaynak / kampanya",
              cell: (row) =>
                row.source || row.campaign ? `${row.source ?? "—"} / ${row.campaign ?? "—"}` : "—",
            },
            {
              key: "status",
              header: "Durum",
              cell: (row) => (
                <StatusBadge tone={row.isActive ? "success" : "neutral"}>
                  {row.isActive ? "Açık" : "Kapalı"}
                </StatusBadge>
              ),
            },
            {
              key: "range",
              header: "Aralıkta tıklama",
              numeric: true,
              cell: (row) => formatCount(row.clicksInRange),
            },
            {
              key: "total",
              header: "Toplam",
              numeric: true,
              cell: (row) => formatCount(row.clicksTotal),
            },
            {
              key: "last",
              header: "Son tıklama",
              cell: (row) => (row.lastClickAt ? formatDateTime(row.lastClickAt) : "—"),
            },
            {
              key: "copy",
              header: "Kopyala",
              cell: (row) => <CopyLinkButton url={`${origin}/${row.slug}`} />,
            },
          ]}
        />
      </Panel>

      <Panel
        id="yeni"
        title="Yeni bağlantı"
        description="Slug oluşturulduktan sonra değişmez; bağlantı silinmez, kapatılır. Hedef yalnızca ManiCepte alan adlarında olabilir."
      >
        <LinkFormClient mode="create" origin={origin} />
      </Panel>
    </div>
  );
}

function rangeQuery(range: { from: string; to: string }): string {
  return `?from=${range.from}&to=${range.to}`;
}
