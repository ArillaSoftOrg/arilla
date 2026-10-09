import {
  type AdminActor,
  getTrafficOverview,
  parseGranularity,
  parseTrafficRange,
  redisTrafficCacheStore,
  TRAFFIC_GRANULARITIES,
  TRAFFIC_PRESETS,
  TRAFFIC_SMALL_CELL_MIN,
  type TrafficBreakdown,
  type TrafficBreakdownRow,
  type TrafficGranularity,
  type TrafficOverview,
  type TrafficRange,
  TrafficRangeError,
  type TrafficTotals,
} from "@arilla/core";
import Link from "next/link";
import { Suspense } from "react";
import { requireCapability } from "../../lib/dal.ts";
import { isGa4MeasurementActive } from "../../lib/ga4.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  ErrorNotice,
  FilterBar,
  FilterField,
  KpiCard,
  Notice,
  PageHeader,
  Panel,
  Skeleton,
  Tabs,
} from "../admin-ui.tsx";
import {
  acquisitionChannelLabel,
  deviceLabel,
  formatCount,
  formatDateTime,
  formatPercent,
  hrefWith,
  trafficDelta,
  trafficErrorLabel,
} from "../format.ts";
import { BarValue, MEASURE_LABELS, TrafficChart, type TrafficMeasure } from "./traffic-chart.tsx";

const PATH = "/yonetim/trafik";
const MEASURES: TrafficMeasure[] = ["users", "sessions", "pageViews"];
const GRANULARITY_LABELS: Record<TrafficGranularity, string> = {
  gun: "Gün",
  hafta: "Hafta",
  ay: "Ay",
};

type Params = {
  gun?: string;
  baslangic?: string;
  bitis?: string;
  dilim?: string;
  olcu?: string;
};

/**
 * Site trafiği (karar 0087, `traffic.read`, yalnızca yönetici). Kaynak GA4
 * Data API; yalnızca analitik çerezine izin veren ziyaretçiler sayılır.
 * Yetki denetimi akış başlamadan önce (404 korunur, karar 0083); veri bölümü
 * kendi Suspense sınırında yüklenir.
 */
export default async function TrafficPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requireCapability("traffic.read");
  const params = await searchParams;
  const now = new Date();
  let rangeError: string | null = null;
  let range: TrafficRange;
  try {
    range = parseTrafficRange(params, now);
  } catch (error) {
    if (!(error instanceof TrafficRangeError)) throw error;
    rangeError = error.message;
    range = parseTrafficRange({}, now);
  }
  const granularity = parseGranularity(params.dilim, range.days);
  const measure: TrafficMeasure = MEASURES.includes(params.olcu as TrafficMeasure)
    ? (params.olcu as TrafficMeasure)
    : "users";
  const rangeParams =
    range.preset === null
      ? { baslangic: range.current.start, bitis: range.current.end }
      : { gun: range.preset };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Site trafiği"
        description="Google Analytics 4 verisi. Yalnızca analitik çerezine izin veren ziyaretçiler sayılır; sayılar sitenin tüm trafiği değildir. GA4 verisi 24–48 saate kadar gecikebilir."
        actions={
          <Tabs
            label="Dönem"
            items={[
              ...TRAFFIC_PRESETS.map((days) => ({
                href: hrefWith(PATH, { gun: days }),
                label: `${days} gün`,
                active: range.preset === days,
              })),
              {
                href: `${PATH}#ozel-aralik`,
                label: "Özel",
                active: range.preset === null,
              },
            ]}
          />
        }
      />

      <FilterBar action={PATH} label="Özel tarih aralığı" resetHref={rangeError ? PATH : null}>
        <FilterField label="Başlangıç">
          <input
            id="ozel-aralik"
            type="date"
            name="baslangic"
            defaultValue={range.current.start}
            required
          />
        </FilterField>
        <FilterField label="Bitiş">
          <input type="date" name="bitis" defaultValue={range.current.end} required />
        </FilterField>
      </FilterBar>

      {rangeError ? (
        <Notice tone="warning" title="Tarih aralığı kullanılamadı">
          {rangeError} Son {range.days} gün gösteriliyor.
        </Notice>
      ) : null}

      <p className={styles.meta}>
        {`Seçili: ${range.current.start} – ${range.current.end} (${range.days} gün) · Önceki dönem: ${range.previous.start} – ${range.previous.end}`}
      </p>

      <Suspense fallback={<TrafficSkeleton />}>
        <TrafficData
          actor={actor}
          range={range}
          granularity={granularity}
          measure={measure}
          baseParams={{ ...rangeParams, dilim: granularity, olcu: measure }}
        />
      </Suspense>
    </div>
  );
}

function TrafficSkeleton() {
  return (
    <div
      className={styles.tiles}
      role="status"
      aria-busy="true"
      aria-label="Trafik verisi yükleniyor"
    >
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className={styles.tile}>
          <Skeleton variant="line" width="60%" />
          <Skeleton variant="value" width="40%" />
        </div>
      ))}
    </div>
  );
}

async function TrafficData({
  actor,
  range,
  granularity,
  measure,
  baseParams,
}: {
  actor: AdminActor;
  range: TrafficRange;
  granularity: TrafficGranularity;
  measure: TrafficMeasure;
  baseParams: Record<string, string | number | undefined>;
}) {
  const result = await getTrafficOverview(
    actor,
    { range, granularity },
    { store: redisTrafficCacheStore() },
  );

  if (result.state === "not_configured" || result.state === "invalid_config") {
    const keys = result.state === "not_configured" ? result.missing : result.problems;
    return (
      <Notice
        tone="warning"
        title={
          result.state === "not_configured"
            ? "GA4 raporlaması bağlı değil"
            : "GA4 raporlama ayarı geçersiz"
        }
      >
        {`${result.state === "not_configured" ? "Tanımsız" : "Geçersiz"}: ${keys.join(", ")}. `}
        Toplama (ölçüm betiği) {isGa4MeasurementActive() ? "bu dağıtımda etkin" : "da etkin değil"}.
        Kurulum adımları docs/ops.md → "GA4"; durum{" "}
        <Link href="/yonetim/ayarlar#grup-analytics">Yapılandırma</Link> sayfasında. Sayı
        gösterilmez: veri yokken tahmin üretilmez.
      </Notice>
    );
  }
  if (result.state === "error") {
    return <ErrorNotice>{trafficErrorLabel(result.error)}</ErrorNotice>;
  }

  const data = result.data;
  return (
    <>
      {result.testEndpoint ? (
        <Notice tone="warning" title="Sahte yerel uç nokta">
          Bu veriler gerçek GA4'ten değil, yerel test sunucusundan geliyor (GA4_TEST_API_BASE_URL).
        </Notice>
      ) : null}
      {result.state === "stale" ? (
        <Notice tone="warning" title="Eski veri gösteriliyor">
          {`${trafficErrorLabel(result.error)} Son başarılı veri: ${formatDateTime(result.fetchedAt)}.`}
        </Notice>
      ) : (
        <p className={styles.meta}>
          {`GA4'ten alındı: ${formatDateTime(result.fetchedAt)}${result.cached ? " (önbellek)" : ""}`}
        </p>
      )}
      <TrafficBody
        data={data}
        measure={measure}
        granularity={granularity}
        baseParams={baseParams}
      />
    </>
  );
}

function totalsCards(current: TrafficTotals, previous: TrafficTotals) {
  const note = (now: number, before: number, format: (n: number) => string) => {
    const delta = trafficDelta(now, before);
    return `Önceki dönem ${format(before)}${delta ? ` · ${delta}` : ""}`;
  };
  return [
    {
      label: "Kullanıcı",
      value: formatCount(current.users),
      note: `${note(current.users, previous.users, formatCount)} · yeni ${formatCount(current.newUsers)}`,
    },
    {
      label: "Oturum",
      value: formatCount(current.sessions),
      note: note(current.sessions, previous.sessions, formatCount),
    },
    {
      label: "Sayfa görüntüleme",
      value: formatCount(current.pageViews),
      note: note(current.pageViews, previous.pageViews, formatCount),
    },
    {
      label: "Etkileşim oranı",
      value: current.engagementRate === null ? "—" : formatPercent(current.engagementRate, 1),
      note:
        previous.engagementRate === null
          ? "Önceki dönemde oturum yok"
          : `Önceki dönem ${formatPercent(previous.engagementRate, 1)}`,
    },
  ];
}

function maxOf(rows: readonly TrafficBreakdownRow[], pick: (row: TrafficBreakdownRow) => number) {
  return Math.max(0, ...rows.map(pick));
}

function suppressedNote(breakdown: TrafficBreakdown): string | null {
  return breakdown.suppressedRows > 0
    ? `${breakdown.suppressedRows} satır ${TRAFFIC_SMALL_CELL_MIN} kullanıcının altında olduğu için "Diğer"e katıldı.`
    : null;
}

function BreakdownTable({
  breakdown,
  firstHeader,
  primaryHeader,
  secondaryHeader,
  labelOf = (row) => row.label,
  withRate = false,
}: {
  breakdown: TrafficBreakdown;
  firstHeader: string;
  primaryHeader: string;
  secondaryHeader: string;
  labelOf?: (row: TrafficBreakdownRow) => string;
  withRate?: boolean;
}) {
  const max = maxOf(breakdown.rows, (row) => row.primary);
  return (
    <DataTable<TrafficBreakdownRow>
      rows={breakdown.rows}
      rowKey={(row) => `${row.label}|${row.detail ?? ""}`}
      stack
      empty={<EmptyPanel title="Bu dönemde veri yok" />}
      columns={[
        { key: "label", header: firstHeader, cell: labelOf },
        {
          key: "primary",
          header: primaryHeader,
          numeric: true,
          cell: (row) => <BarValue value={row.primary} max={max} />,
        },
        {
          key: "secondary",
          header: secondaryHeader,
          numeric: true,
          cell: (row) => formatCount(row.secondary),
        },
        ...(withRate
          ? [
              {
                key: "rate",
                header: "Etkileşim",
                numeric: true,
                cell: (row: TrafficBreakdownRow) =>
                  row.rate === undefined || row.rate === null ? "—" : formatPercent(row.rate, 1),
              },
            ]
          : []),
      ]}
    />
  );
}

function TrafficBody({
  data,
  measure,
  granularity,
  baseParams,
}: {
  data: TrafficOverview;
  measure: TrafficMeasure;
  granularity: TrafficGranularity;
  baseParams: Record<string, string | number | undefined>;
}) {
  const empty = data.totals.current.sessions === 0 && data.totals.current.users === 0;
  return (
    <>
      <section className={styles.kpiGroup} aria-labelledby="trafik-ozet">
        <h2 id="trafik-ozet" className={styles.kpiGroupTitle}>
          Özet
        </h2>
        <div className={styles.tiles}>
          {totalsCards(data.totals.current, data.totals.previous).map((card) => (
            <KpiCard key={card.label} {...card} basis="consent_sample" />
          ))}
        </div>
      </section>

      {empty ? (
        <EmptyPanel
          title="Bu dönemde ölçülmüş ziyaret yok"
          description="Ölçüm yeni açıldıysa ya da kimse analitik çerezine izin vermediyse veri olmaz."
        />
      ) : null}

      <Panel
        id="egri"
        title="Zaman içinde"
        description="Seçili dönem ile hemen önceki aynı uzunluktaki dönem."
        actions={
          <>
            <Tabs
              label="Ölçü"
              items={MEASURES.map((item) => ({
                href: `${hrefWith(PATH, { ...baseParams, olcu: item })}#egri`,
                label: MEASURE_LABELS[item],
                active: measure === item,
              }))}
            />
            <Tabs
              label="Zaman dilimi"
              items={TRAFFIC_GRANULARITIES.map((item) => ({
                href: `${hrefWith(PATH, { ...baseParams, dilim: item })}#egri`,
                label: GRANULARITY_LABELS[item],
                active: granularity === item,
              }))}
            />
          </>
        }
      >
        <TrafficChart series={data.series} measure={measure} granularity={granularity} />
      </Panel>

      <div className={styles.twoColumn}>
        <Panel
          id="kanallar"
          title="Edinme kanalları"
          description="Oturumun varsayılan kanal grubu."
          actions={<DataBasis kind="consent_sample" />}
          flush={data.channels.rows.length > 0}
        >
          <BreakdownTable
            breakdown={data.channels}
            firstHeader="Kanal"
            primaryHeader="Oturum"
            secondaryHeader="Kullanıcı"
            labelOf={(row) => acquisitionChannelLabel(row.label)}
            withRate
          />
        </Panel>
        <Panel
          id="kaynaklar"
          title="Trafik kaynakları"
          description={suppressedNote(data.sources) ?? "Kaynak / ortam, en çok 25."}
          actions={<DataBasis kind="consent_sample" />}
          flush={data.sources.rows.length > 0}
        >
          <BreakdownTable
            breakdown={data.sources}
            firstHeader="Kaynak / ortam"
            primaryHeader="Oturum"
            secondaryHeader="Kullanıcı"
            labelOf={(row) => (row.detail ? `${row.label} / ${row.detail}` : row.label)}
          />
        </Panel>
      </div>

      <Panel
        id="sayfalar"
        title="Popüler sayfalar"
        description="Arındırılmış sayfa yolu (sorgu parametresi ve kimlik içermez), en çok 20."
        actions={<DataBasis kind="consent_sample" />}
        flush={data.pages.rows.length > 0}
      >
        <BreakdownTable
          breakdown={data.pages}
          firstHeader="Sayfa"
          primaryHeader="Görüntüleme"
          secondaryHeader="Kullanıcı"
        />
      </Panel>

      <div className={styles.twoColumn}>
        <Panel
          id="cihazlar"
          title="Cihaz"
          actions={<DataBasis kind="consent_sample" />}
          flush={data.devices.rows.length > 0}
        >
          <BreakdownTable
            breakdown={data.devices}
            firstHeader="Cihaz türü"
            primaryHeader="Kullanıcı"
            secondaryHeader="Oturum"
            labelOf={(row) => deviceLabel(row.label)}
          />
        </Panel>
        <Panel
          id="ulkeler"
          title="Ülke"
          description={suppressedNote(data.countries) ?? "En çok 25 ülke."}
          actions={<DataBasis kind="consent_sample" />}
          flush={data.countries.rows.length > 0}
        >
          <BreakdownTable
            breakdown={data.countries}
            firstHeader="Ülke"
            primaryHeader="Kullanıcı"
            secondaryHeader="Oturum"
          />
        </Panel>
        <Panel
          id="bolgeler"
          title="Türkiye içi bölge"
          description={
            suppressedNote(data.regions) ?? "GA4'ün bölge (il düzeyi) tahmini, en çok 30."
          }
          actions={<DataBasis kind="consent_sample" />}
          flush={data.regions.rows.length > 0}
        >
          <BreakdownTable
            breakdown={data.regions}
            firstHeader="Bölge"
            primaryHeader="Kullanıcı"
            secondaryHeader="Oturum"
          />
        </Panel>
      </div>

      <Notice title="Veri temeli">
        Yalnızca analitik çerezine izin veren ziyaretçiler; yönetim, giriş alt yolları ve API
        ölçülmez. Konum GA4'ün IP'den çıkardığı yaklaşık bölgedir. {TRAFFIC_SMALL_CELL_MIN}{" "}
        kullanıcının altındaki ülke, bölge ve kaynak satırları birleştirilir.
      </Notice>
    </>
  );
}
