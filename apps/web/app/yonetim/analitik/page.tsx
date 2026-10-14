import {
  fetchAnalyticsReport,
  istanbulToday,
  LABEL_PATTERN,
  type Overview,
  resolveStatsRange,
  umamiApiFromEnv,
} from "@arilla/core";
import { requireCapability } from "../../lib/dal.ts";
import { isUmamiTrackerActive } from "../../lib/umami.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  EmptyPanel,
  FilterBar,
  FilterField,
  KpiCard,
  Notice,
  PageHeader,
  Panel,
  Tabs,
} from "../admin-ui.tsx";
import { formatCount, formatPercent, hrefWith, trafficDelta } from "../format.ts";
import { ClicksChart } from "../takip-baglantilari/clicks-chart.tsx";
import { MetricTable, SectionNotice, umamiLabel } from "./umami-sections.tsx";

const PATH = "/yonetim/analitik";
const PRESETS = [
  { label: "Son 7 gün", days: 7 },
  { label: "Son 28 gün", days: 28 },
  { label: "Son 90 gün", days: 90 },
] as const;

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

function duration(totaltime: number, visits: number): string {
  if (visits <= 0) return "—";
  const seconds = Math.round(totaltime / visits);
  return seconds >= 60 ? `${Math.floor(seconds / 60)} dk ${seconds % 60} sn` : `${seconds} sn`;
}

function cards(current: Overview) {
  const before = current.comparison;
  const note = (now: number, prev: number | undefined) => {
    if (prev === undefined) return null;
    const delta = trafficDelta(now, prev);
    return `Önceki dönem ${formatCount(prev)}${delta ? ` · ${delta}` : ""}`;
  };
  return [
    {
      label: "Ziyaretçi",
      value: formatCount(current.visitors),
      note: note(current.visitors, before?.visitors),
    },
    {
      label: "Ziyaret",
      value: formatCount(current.visits),
      note: note(current.visits, before?.visits),
    },
    {
      label: "Sayfa görüntüleme",
      value: formatCount(current.pageviews),
      note: note(current.pageviews, before?.pageviews),
    },
    {
      label: "Hemen çıkma",
      value: formatPercent(current.bounces, current.visits),
      note: "Tek sayfa görüntülenen ziyaretlerin oranı",
    },
    {
      label: "Ortalama ziyaret süresi",
      value: duration(current.totaltime, current.visits),
      note: null,
    },
  ];
}

/**
 * Ziyaretçi analitiği (karar 0116, `traffic.read`, yalnızca yönetici). Veri Umami'nin
 * belgelenmiş `stats`, `pageviews` ve `metrics` uç noktalarından sunucuda alınır; anahtar
 * tarayıcıya gitmez. Umami yanıt vermezse yalnız bu ekran uyarır (varsa eski veri), site
 * ve kısa bağlantılar etkilenmez. Yalnızca analitik rızası veren ziyaretçiler ölçülür.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; kampanya?: string }>;
}) {
  await requireCapability("traffic.read");
  const params = await searchParams;
  const range = resolveStatsRange({ from: params.from, to: params.to });
  const campaign =
    params.kampanya && LABEL_PATTERN.test(params.kampanya.trim().toLowerCase())
      ? params.kampanya.trim().toLowerCase()
      : undefined;
  const today = istanbulToday();
  const activePreset = PRESETS.find(
    (preset) => range.to === today && range.from === shiftDay(today, -(preset.days - 1)),
  );
  const config = umamiApiFromEnv();

  const header = (
    <PageHeader
      title="Ziyaretçi analitiği"
      description="Umami: ziyaretçi, sayfa görüntüleme, trafik kaynağı, kampanya, ülke, cihaz ve tarayıcı. Yalnızca analitik rızası veren ziyaretçiler ölçülür; kısa bağlantı tıklama sayısıyla (Arilla sayacı) aynı şey değildir."
      actions={
        <Tabs
          label="Tarih aralığı"
          items={PRESETS.map((preset) => ({
            href: hrefWith(PATH, {
              from: shiftDay(today, -(preset.days - 1)),
              to: today,
              kampanya: campaign,
            }),
            label: preset.label,
            active: activePreset?.days === preset.days,
          }))}
        />
      }
    />
  );

  if (config.status !== "ok") {
    return (
      <div className={styles.page}>
        {header}
        <Panel id="ayar" title="Umami yapılandırılmamış">
          {config.status === "invalid" ? (
            <Notice tone="warning" title="Geçersiz yapılandırma">
              Şu ortam değişkenleri tanımsız ya da geçersiz: {config.problems.join(", ")}. Değerler
              gösterilmez.
            </Notice>
          ) : (
            <EmptyPanel
              title="Umami raporlaması kapalı"
              description="UMAMI_BASE_URL, UMAMI_WEBSITE_ID ve UMAMI_API_KEY tanımlanınca bu ekran dolar (docs/ops.md)."
            />
          )}
          <p className={styles.muted}>
            Ziyaretçi ölçüm betiği bu dağıtımda {isUmamiTrackerActive() ? "etkin" : "etkin değil"}.
          </p>
        </Panel>
      </div>
    );
  }

  const report = await fetchAnalyticsReport(config.config, range, { utmCampaign: campaign });
  const series = report.series;
  const hourly = range.days <= 2;

  return (
    <div className={styles.page}>
      {header}

      <Panel
        id="aralik"
        title="Dönem ve süzgeç"
        description={`${range.from} – ${range.to} (Europe/Istanbul, ${range.days} gün).`}
      >
        <FilterBar action={PATH} resetHref={PATH} label="Dönem ve süzgeç">
          <FilterField label="Başlangıç">
            <input type="date" name="from" defaultValue={range.from} max={today} required />
          </FilterField>
          <FilterField label="Bitiş">
            <input type="date" name="to" defaultValue={range.to} max={today} required />
          </FilterField>
          <FilterField label="Kampanya (utm_campaign)">
            <input name="kampanya" defaultValue={campaign ?? ""} maxLength={40} />
          </FilterField>
        </FilterBar>
      </Panel>

      <Panel id="ozet" title="Özet" actions={<DataBasis kind="consent_sample" />}>
        <SectionNotice section={report.overview} />
        {report.overview.ok ? (
          <div className={styles.tiles}>
            {cards(report.overview.value).map((card) => (
              <KpiCard key={card.label} label={card.label} value={card.value} note={card.note} />
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel
        id="egri"
        title={hourly ? "Saatlik sayfa görüntüleme" : "Günlük sayfa görüntüleme"}
        actions={<DataBasis kind="consent_sample" />}
      >
        <SectionNotice section={series} />
        {series?.ok ? (
          <ClicksChart
            series={series.value.map((point) => ({
              label: point.label,
              clicks: point.pageviews,
            }))}
            unitLabel={hourly ? "Saat" : "Gün"}
            valueLabel="Sayfa görüntüleme"
            formatLabel={umamiLabel}
          />
        ) : null}
      </Panel>

      <div className={styles.twoColumn}>
        <Panel
          id="kaynaklar"
          title="Yönlendiren siteler"
          description="Ziyareti getiren alan adı; boş = doğrudan ya da bilinmiyor."
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.referrer}
            firstHeader="Yönlendiren"
            valueHeader="Ziyaretçi"
            fold
          />
        </Panel>
        <Panel
          id="kampanyalar"
          title="Kampanyalar (utm_campaign)"
          description="Kısa bağlantılar kaynak/kampanya doluysa hedefe utm_* ekler."
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.utmCampaign}
            firstHeader="Kampanya"
            valueHeader="Ziyaretçi"
          />
        </Panel>
      </div>

      <div className={styles.twoColumn}>
        <Panel
          id="utm-kaynak"
          title="UTM kaynağı"
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.utmSource}
            firstHeader="utm_source"
            valueHeader="Ziyaretçi"
          />
        </Panel>
        <Panel
          id="utm-ortam"
          title="UTM ortamı"
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.utmMedium}
            firstHeader="utm_medium"
            valueHeader="Ziyaretçi"
          />
        </Panel>
      </div>

      <Panel
        id="sayfalar"
        title="Popüler sayfalar"
        description="Arındırılmış sayfa yolu (sorgu ve kimlik içermez), en çok 10."
        actions={<DataBasis kind="consent_sample" />}
        flush
      >
        <MetricTable section={report.metrics.path} firstHeader="Sayfa" valueHeader="Görüntüleme" />
      </Panel>

      <div className={styles.twoColumn}>
        <Panel
          id="ulkeler"
          title="Ülke"
          description="5 ziyaretçiden az satırlar Diğer'e katılır."
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.country}
            firstHeader="Ülke"
            valueHeader="Ziyaretçi"
            fold
          />
        </Panel>
        <Panel id="cihazlar" title="Cihaz" actions={<DataBasis kind="consent_sample" />} flush>
          <MetricTable
            section={report.metrics.device}
            firstHeader="Cihaz"
            valueHeader="Ziyaretçi"
            fold
          />
        </Panel>
      </div>

      <div className={styles.twoColumn}>
        <Panel
          id="tarayicilar"
          title="Tarayıcı"
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.browser}
            firstHeader="Tarayıcı"
            valueHeader="Ziyaretçi"
            fold
          />
        </Panel>
        <Panel
          id="isletim"
          title="İşletim sistemi"
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <MetricTable
            section={report.metrics.os}
            firstHeader="İşletim sistemi"
            valueHeader="Ziyaretçi"
            fold
          />
        </Panel>
      </div>

      <Panel
        id="olaylar"
        title="Olaylar"
        description="Gönderilen tek özel olay early_access_joined (erken erişim kaydı, yalnızca rızayla). Kampanya kırılımı için Umami arayüzündeki olay verisi kullanılır; bu ekran yalnızca sayıyı gösterir."
        actions={<DataBasis kind="consent_sample" />}
        flush
      >
        <MetricTable section={report.metrics.event} firstHeader="Olay" valueHeader="Sayı" />
      </Panel>

      <Notice tone="info" title="Nasıl okunur">
        Rıza vermeyen, reklam engelleyici kullanan ve bot ziyaretçiler Umami&apos;de görünmez
        (botlar Umami tarafından varsayılan olarak dışlanır). GA4 ayrı bir araçtır:
        <a href="/yonetim/trafik"> Site trafiği</a> sayfasındaki sayılarla toplanmaz; iki araç
        birbirinden bağımsız ölçer.
      </Notice>
    </div>
  );
}
