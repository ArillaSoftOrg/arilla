import {
  getTrackingLink,
  getTrackingLinkStats,
  istanbulToday,
  readAppUrl,
  resolveStatsRange,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import {
  DataBasis,
  FilterBar,
  FilterField,
  KeyValues,
  KpiCard,
  PageHeader,
  Panel,
  StatusBadge,
} from "../../admin-ui.tsx";
import { formatCount, formatDateTime, hrefWith, positiveInt } from "../../format.ts";
import { ClicksChart } from "../clicks-chart.tsx";
import { CopyLinkButton, ToggleActiveButton } from "../link-actions-client.tsx";
import { LinkFormClient } from "../link-form-client.tsx";

const PATH = "/yonetim/takip-baglantilari";

/** `2026-03-11` → `11.03.2026`; `2026-03-11T14:00` → `11.03 14:00`. */
function dayLabel(label: string): string {
  const [y, m, d] = label.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}
function hourLabel(label: string): string {
  const [date, time] = label.split("T");
  const [, m, d] = (date ?? "").split("-");
  return `${d}.${m} ${time}`;
}

export default async function TrackingLinkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { actor } = await requireCapability("links.read");
  const id = positiveInt((await params).id);
  if (!id) notFound();
  const query = await searchParams;
  const range = resolveStatsRange({ from: query.from, to: query.to });
  const db = getDatabase();
  const link = await getTrackingLink(db, actor, id);
  if (!link) notFound();
  const stats = await getTrackingLinkStats(db, actor, { linkId: id, range });
  const origin = readAppUrl() ?? "";
  const publicUrl = `${origin}/${link.slug}`;
  const today = istanbulToday();
  const backHref = hrefWith(PATH, { from: range.from, to: range.to });

  return (
    <div className={styles.page}>
      <PageHeader
        title={link.name}
        description={
          <>
            <Link href={backHref}>← Tüm bağlantılar</Link>
            {" · "}
            <span className={styles.mono}>{publicUrl}</span>
          </>
        }
        actions={
          <span className={styles.row}>
            <StatusBadge tone={link.isActive ? "success" : "neutral"}>
              {link.isActive ? "Açık" : "Kapalı"}
            </StatusBadge>
            <CopyLinkButton url={publicUrl} />
            <ToggleActiveButton id={link.id} active={link.isActive} />
          </span>
        }
      />

      <Panel
        id="aralik"
        title="Tarih aralığı"
        description={`${range.from} – ${range.to} (Europe/Istanbul, ${range.days} gün).`}
      >
        <FilterBar
          action={`${PATH}/${link.id}`}
          resetHref={`${PATH}/${link.id}`}
          label="Tarih aralığı"
        >
          <FilterField label="Başlangıç">
            <input type="date" name="from" defaultValue={range.from} max={today} required />
          </FilterField>
          <FilterField label="Bitiş">
            <input type="date" name="to" defaultValue={range.to} max={today} required />
          </FilterField>
        </FilterBar>
      </Panel>

      <Panel id="ozet" title="Özet" actions={<DataBasis kind="count" />}>
        <div className={styles.tiles}>
          <KpiCard label="Tıklama (aralık)" value={formatCount(stats.total)} />
          <KpiCard
            label="Günlük ortalama"
            value={formatCount(Math.round(stats.total / Math.max(1, stats.range.days)))}
          />
          <KpiCard
            label="En yoğun gün"
            value={stats.peakDay ? formatCount(stats.peakDay.clicks) : "—"}
            note={stats.peakDay ? dayLabel(stats.peakDay.day) : "Tıklama yok"}
          />
        </div>
      </Panel>

      <Panel
        id="gunluk"
        title="Günlük tıklama"
        description="Gün sınırı Europe/Istanbul. Bot, ön yükleme ve HEAD istekleri sayılmaz."
      >
        <ClicksChart
          series={stats.daily.map((point) => ({ label: point.day, clicks: point.clicks }))}
          unitLabel="Gün"
          formatLabel={dayLabel}
        />
      </Panel>

      <Panel
        id="saatlik"
        title="Saatlik tıklama"
        description={
          stats.hourly
            ? "Saat Europe/Istanbul yerel saatidir."
            : "Saatlik görünüm için en fazla 3 günlük bir aralık seç."
        }
      >
        {stats.hourly ? (
          <ClicksChart series={stats.hourly} unitLabel="Saat" formatLabel={hourLabel} />
        ) : (
          <p className={styles.muted}>Seçili aralık {stats.range.days} gün.</p>
        )}
      </Panel>

      <Panel
        id="duzenle"
        title="Düzenle"
        description="Slug değişmez. Değişiklik hemen yayına yansır."
      >
        <LinkFormClient
          mode="edit"
          id={link.id}
          expectedUpdatedAt={link.updatedAt.toISOString()}
          slug={link.slug}
          origin={origin}
          name={link.name}
          targetUrl={link.targetUrl}
          source={link.source ?? ""}
          campaign={link.campaign ?? ""}
        />
      </Panel>

      <Panel id="bilgi" title="Kayıt">
        <KeyValues
          items={[
            ["Oluşturulma", formatDateTime(link.createdAt)],
            ["Son güncelleme", formatDateTime(link.updatedAt)],
          ]}
        />
      </Panel>
    </div>
  );
}
