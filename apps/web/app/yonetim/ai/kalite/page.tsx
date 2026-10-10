import {
  ANALYTICS_WINDOWS,
  COMPONENT_LABELS,
  type ComponentQuality,
  type ErrorDistributionRow,
  getAiQualityOverview,
  type MetricView,
  type QualityRun,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  KeyValues,
  KpiCard,
  Notice,
  PageHeader,
  Panel,
  Tabs,
} from "../../admin-ui.tsx";
import {
  aiErrorClassLabel,
  aiProviderLabel,
  evalFailureClassLabel,
  formatCostMicros,
  formatCount,
  formatDateTime,
  formatRatio,
  hrefWith,
} from "../../format.ts";

const PATH = "/yonetim/ai/kalite";
const NO_DATA = "Henüz veri yok";

function windowLabel(days: number): string {
  return days === 1 ? "Son 24 saat" : `Son ${days} gün`;
}

function deltaText(metric: MetricView): string | null {
  if (metric.delta === null) return null;
  const points = (metric.delta * 100).toLocaleString("tr-TR", {
    signDisplay: "exceptZero",
    maximumFractionDigits: 1,
  });
  return `${points} puan`;
}

function statusText(metric: MetricView): string {
  switch (metric.status) {
    case "regressed":
      return "Geriledi";
    case "improved":
      return "İyileşti";
    case "same":
      return "Değişmedi";
    case "no_baseline":
      return "Karşılaştırılamaz";
    default:
      return NO_DATA;
  }
}

function comparabilityNote(quality: ComponentQuality): string | null {
  if (!quality.latest) return null;
  if (quality.comparability === "no_previous") return "Karşılaştırılacak önceki koşu yok.";
  if (quality.comparability === "dataset_changed") {
    return "Önceki koşu farklı veri setiyle yapılmış; eşit koşulda olmadığı için regresyon hesaplanmadı.";
  }
  return null;
}

function runBasis(run: QualityRun): string {
  return `${run.datasetVersion} · ${formatCount(run.verifiedCount)} doğrulanmış örnek · ${run.live ? "canlı" : "çevrimdışı"}`;
}

/**
 * AI değerlendirme ve kalite paneli (karar 0097, `ai.read`, yalnızca yönetici).
 * Yalnızca kaydedilmiş değerlendirme sonuçlarını okur: açılışta Gemini/Jina
 * çalışmaz. Veri yoksa "Henüz veri yok" yazılır, sıfır gösterilmez. Ham sorgu,
 * sohbet metni ve kullanıcı kimliği hiçbir yerde yoktur.
 */
export default async function AiQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ gun?: string }>;
}) {
  const { actor } = await requireCapability("ai.read");
  const params = await searchParams;
  const overview = await getAiQualityOverview(getDatabase(), actor, { days: params.gun });
  const anyRun = overview.components.some((c) => c.latest);
  const regressedCount = overview.components.filter((c) => c.regressed).length;

  return (
    <div className={styles.page}>
      <PageHeader
        title="AI kalite ve değerlendirme"
        description={`Kaydedilmiş değerlendirme koşuları, regresyon ve model hataları. ${formatDateTime(overview.generatedAt)} itibarıyla; bu ekran model çağırmaz.`}
        actions={
          <Tabs
            label="Zaman aralığı"
            items={ANALYTICS_WINDOWS.map((days) => ({
              href: hrefWith(PATH, { gun: days }),
              label: windowLabel(days),
              active: days === overview.days,
            }))}
          />
        }
      />

      <div className={styles.kpiGrid}>
        <KpiCard
          label="Regresyon"
          value={anyRun ? formatCount(regressedCount) : NO_DATA}
          note={
            anyRun
              ? "Önceki koşuya göre gerileyen bileşen (aynı veri setinde)"
              : "Henüz kaydedilmiş değerlendirme koşusu yok"
          }
          tone={regressedCount > 0 ? "critical" : "neutral"}
          status={regressedCount > 0 ? "Geriledi" : null}
          basis="count"
        />
        <KpiCard
          label={`Model hatası (${windowLabel(overview.days).toLowerCase()})`}
          value={formatCount(overview.errors.total)}
          note="Kayıtlı hata olayı; üretim çağıranları henüz bağlı olmayabilir"
          basis="count"
        />
        <KpiCard
          label="Değerlendirme maliyeti"
          value={
            overview.evalCost.runs === 0 ? NO_DATA : formatCostMicros(overview.evalCost.costMicros)
          }
          note={`${formatCount(overview.evalCost.runs)} koşu · ${formatCount(overview.evalCost.liveRuns)} canlı · ${formatCount(overview.evalCost.apiCalls)} çağrı`}
          basis="count"
        />
      </div>

      {overview.components.map((quality) => (
        <Panel
          key={quality.component}
          id={quality.component}
          title={COMPONENT_LABELS[quality.component]}
          description={
            quality.latest
              ? `Son koşu ${formatDateTime(quality.latest.createdAt)} · ${runBasis(quality.latest)}`
              : "Bu bileşen için kaydedilmiş koşu yok."
          }
          flush={quality.latest !== null}
          actions={<DataBasis kind="count" />}
        >
          {quality.latest === null ? (
            <EmptyPanel
              title={NO_DATA}
              description="Değerlendirme koşusu kaydedildiğinde burada görünür."
            />
          ) : (
            <>
              <DataTable<MetricView>
                rows={quality.metrics}
                rowKey={(row) => row.key}
                stack
                columns={[
                  { key: "m", header: "Metrik", cell: (row) => row.label },
                  {
                    key: "v",
                    header: "Son koşu",
                    numeric: true,
                    cell: (row) => (row.value === null ? NO_DATA : formatRatio(row.value)),
                  },
                  {
                    key: "p",
                    header: "Önceki koşu",
                    numeric: true,
                    cell: (row) => (row.previous === null ? "—" : formatRatio(row.previous)),
                  },
                  {
                    key: "d",
                    header: "Fark",
                    numeric: true,
                    cell: (row) => deltaText(row) ?? "—",
                  },
                  { key: "s", header: "Durum", cell: statusText },
                ]}
              />
              <KeyValues
                items={[
                  ["Algoritma sürümü", quality.latest.algorithmVersion],
                  ["Model sürümü", quality.latest.modelVersion ?? "— (model kullanılmadı)"],
                  [
                    "Gecikme (p50 / p95)",
                    quality.latest.latencyP50Ms === null && quality.latest.latencyP95Ms === null
                      ? NO_DATA
                      : `${quality.latest.latencyP50Ms ?? "—"} / ${quality.latest.latencyP95Ms ?? "—"} ms`,
                  ],
                  ...quality.failureClasses.map(
                    (f) =>
                      [
                        `Başarısız vaka: ${evalFailureClassLabel(f.failureClass)}`,
                        formatCount(f.count),
                      ] as [string, string],
                  ),
                ]}
              />
              {comparabilityNote(quality) ? (
                <Notice title="Not">{comparabilityNote(quality)}</Notice>
              ) : null}
            </>
          )}
        </Panel>
      ))}

      <div className={styles.panelGrid}>
        <Panel
          id="hatalar"
          title="AI hata türleri"
          description="Sağlayıcı × hata sınıfı; istem/yanıt metni ve kullanıcı kaydedilmez."
          flush={overview.errors.byKind.length > 0}
        >
          <DataTable<ErrorDistributionRow>
            rows={overview.errors.byKind}
            rowKey={(row) => `${row.provider}|${row.errorClass}`}
            empty={
              <EmptyPanel
                title="Bu aralıkta kayıtlı hata yok"
                description="Hata kaydı bağlantısı üretimde henüz açık olmayabilir."
              />
            }
            columns={[
              { key: "p", header: "Sağlayıcı", cell: (row) => aiProviderLabel(row.provider) },
              { key: "c", header: "Hata türü", cell: (row) => aiErrorClassLabel(row.errorClass) },
              { key: "n", header: "Sayı", numeric: true, cell: (row) => formatCount(row.count) },
              {
                key: "l",
                header: "Gecikme p95",
                numeric: true,
                cell: (row) =>
                  row.p95LatencyMs === null ? "—" : `${formatCount(row.p95LatencyMs)} ms`,
              },
            ]}
          />
        </Panel>

        <Panel
          id="surumler"
          title="Kullanımdaki model sürümleri"
          description="api_usage kaydındaki model etiketi ve çağrı sayısı."
          footer={<Link href="/yonetim/ai">AI operasyonları ve maliyet</Link>}
        >
          {overview.modelVersionsInUse.length === 0 ? (
            <p className={styles.muted}>Bu aralıkta model çağrısı yok.</p>
          ) : (
            <KeyValues
              items={overview.modelVersionsInUse.map((row) => [row.label, formatCount(row.calls)])}
            />
          )}
        </Panel>
      </div>

      <Panel
        id="gecmis"
        title="Değerlendirme geçmişi"
        description="En yeni 50 koşu. Maliyet kayıtlı özettir; kaynak api_usage."
        flush={overview.history.length > 0}
      >
        <DataTable<QualityRun>
          rows={overview.history}
          rowKey={(row) => String(row.id)}
          stack
          empty={<EmptyPanel title={NO_DATA} description="Bu aralıkta değerlendirme koşusu yok." />}
          columns={[
            { key: "t", header: "Zaman", cell: (row) => formatDateTime(row.createdAt) },
            { key: "c", header: "Bileşen", cell: (row) => COMPONENT_LABELS[row.component] },
            {
              key: "a",
              header: "Sürüm",
              cell: (row) => (
                <span className={styles.mono}>
                  {row.algorithmVersion}
                  {row.modelVersion ? ` · ${row.modelVersion}` : ""}
                </span>
              ),
            },
            {
              key: "d",
              header: "Veri seti",
              cell: (row) => `${row.datasetVersion} (${formatCount(row.verifiedCount)})`,
            },
            { key: "k", header: "Tür", cell: (row) => (row.live ? "Canlı" : "Çevrimdışı") },
            { key: "u", header: "Çağrı", numeric: true, cell: (row) => formatCount(row.apiCalls) },
            {
              key: "m",
              header: "Maliyet",
              numeric: true,
              cell: (row) => (row.live ? formatCostMicros(row.costMicros) : "—"),
            },
            {
              key: "r",
              header: "Regresyon",
              cell: (row) =>
                row.regressedFlag === null ? "—" : row.regressedFlag ? "Geriledi" : "Hayır",
            },
          ]}
        />
      </Panel>

      <Notice title="Okuma notu">
        Oranlar yalnızca kaydedilmiş koşulardan gelir; koşu yoksa değer üretilmez. Doğrulanmış örnek
        sayısı küçük setlerde oranları kaba yapar (örnek sayısı koşu satırında yazılır). Arama
        kalitesi canlı trafikten değil, altın sorgu setinden ölçülür.
      </Notice>
    </div>
  );
}
