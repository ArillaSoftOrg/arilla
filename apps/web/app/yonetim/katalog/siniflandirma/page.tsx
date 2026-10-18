import { getClassificationMonitor, jobLabel, STALL_AFTER_MS } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import {
  DataTable,
  EmptyPanel,
  KpiCard,
  KpiGroup,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  StatusText,
} from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash, formatDuration, formatPercent } from "../../format.ts";
import { classificationDetailLabel, RUN_STATUS_BADGES } from "../urunler/product-labels.ts";
import local from "../urunler/products.module.css";

const PRODUCTS = "/yonetim/katalog/urunler";

/**
 * Sınıflandırma izleme (karar 0133). YALNIZCA GERÇEK KAYITLAR: kontrol noktası
 * (`product_classification_state`), koşu kaydı (`job_run`, iş `classify_products`)
 * ve açık kanıt satırları (`product_classification_open_idx`). Bu ekran işi
 * başlatmaz ya da durdurmaz; komut `services/ingest` tarafındadır.
 */
export default async function ClassificationMonitorPage() {
  const { actor } = await requireCapability("catalog.read");
  const monitor = await getClassificationMonitor(getDatabase(), actor);
  const { current } = monitor;
  const status = RUN_STATUS_BADGES[monitor.status];
  const lastRun = monitor.runs[0] ?? null;
  const progress =
    current && monitor.maxProductId ? Math.min(current.lastProductId / monitor.maxProductId, 1) : 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Sınıflandırma izleme"
        description="Marka ve kategori sınıflandırma işinin (karar 0133) kontrol noktası, koşuları ve inceleme kuyruğu. Salt okunur."
        actions={<Link href={PRODUCTS}>Ürünler</Link>}
      />

      <Notice>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>{" "}
        {monitor.status === "stalled"
          ? `Koşu açık görünüyor ama kontrol noktası ${formatDuration(STALL_AFTER_MS)}'dan uzun süredir ilerlemiyor (WAL geri basıncı, kilit beklemesi ya da süreç sonlanmış olabilir).`
          : monitor.status === "paused"
            ? "Tarama tamamlanmadı ve koşan iş yok; aynı komut kaldığı yerden devam eder."
            : monitor.status === "never"
              ? "Bu veritabanında sınıflandırma hiç çalışmadı."
              : null}
      </Notice>

      {current ? (
        <>
          <KpiGroup title={`Kural v${current.ruleVersion} · tüm katalog`}>
            <KpiCard
              label="Taranan ürün"
              value={formatCount(current.scanned)}
              note="Tüm yayın durumları dahil; bu kural sürümünde"
              basis="count"
            />
            <KpiCard
              label="Kategori atanan"
              value={formatCount(current.categorySet)}
              note={`İşin yazdığı · taranana oranı ${formatPercent(current.categorySet, current.scanned)}`}
              basis="count"
            />
            <KpiCard
              label="Marka atanan"
              value={formatCount(current.brandSet)}
              note={`İşin yazdığı · taranana oranı ${formatPercent(current.brandSet, current.scanned)}`}
              basis="count"
            />
            <KpiCard
              label="İnceleme gereken"
              value={formatCount(monitor.openReview)}
              note={`Şu an açık (tüm sürümler) · bu koşuda ${formatCount(current.review)}`}
              tone={monitor.openReview > 0 ? "warning" : "neutral"}
              href={`${PRODUCTS}?siniflandirma=review&durum=all`}
            />
            <KpiCard
              label="Hatalar"
              value={formatCount(monitor.openErrors)}
              note={`Şu an açık · bu koşuda ${formatCount(current.errors)}`}
              tone={monitor.openErrors > 0 ? "critical" : "neutral"}
              href={`${PRODUCTS}?siniflandirma=error&durum=all`}
            />
          </KpiGroup>

          <Panel id="ilerleme" title="İlerleme">
            <div className={local.progressRow}>
              <div className={local.progressHead}>
                <span>Kimlik aralığında ilerleme (yaklaşık; kimlikler seyrek olabilir)</span>
                <span>{`${(progress * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}%`}</span>
              </div>
              <span
                className={local.bar}
                role="progressbar"
                aria-label="Kimlik aralığında ilerleme"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <span
                  className={local.barFill}
                  style={{ width: `${(progress * 100).toFixed(1)}%` }}
                />
              </span>
            </div>
            <dl className={local.facts}>
              <dt>Son işlenen ürün</dt>
              <dd>
                {monitor.lastProduct ? (
                  <Link href={`${PRODUCTS}?urun=${monitor.lastProduct.id}&durum=all`}>
                    {`#${monitor.lastProduct.id}${monitor.lastProduct.title ? ` · ${monitor.lastProduct.title}` : " (silinmiş)"}`}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
              <dt>En yüksek ürün kimliği</dt>
              <dd>{monitor.maxProductId ? `#${monitor.maxProductId}` : "—"}</dd>
              <dt>Başladı</dt>
              <dd>{formatDateOrDash(current.startedAt)}</dd>
              <dt>Son ilerleme</dt>
              <dd>{formatDateOrDash(current.updatedAt)}</dd>
              <dt>Tamamlandı</dt>
              <dd>{formatDateOrDash(current.completedAt)}</dd>
              <dt>Son koşu</dt>
              <dd>
                {lastRun ? (
                  <>
                    <StatusText status={lastRun.status} />
                    {` · ${formatDateOrDash(lastRun.startedAt)}`}
                    {lastRun.finishedAt ? ` → ${formatDateOrDash(lastRun.finishedAt)}` : ""}
                  </>
                ) : (
                  "Koşu kaydı yok"
                )}
              </dd>
            </dl>
          </Panel>
        </>
      ) : (
        <EmptyPanel
          title="Kontrol noktası yok"
          description="Sınıflandırma işi bu veritabanında hiç çalışmadı; sayılar gösterilmez."
        />
      )}

      <Panel
        id="acik"
        title="Açık kanıt satırları"
        description="İnceleme ve hata, nedene göre."
        flush
      >
        <DataTable
          rows={monitor.open}
          rowKey={(row) => `${row.state}:${row.detail ?? ""}`}
          empty={<EmptyPanel title="Açık satır yok" />}
          stack
          columns={[
            {
              key: "state",
              header: "Durum",
              cell: (row) => (
                <StatusBadge tone={row.state === "error" ? "critical" : "warning"}>
                  {row.state === "error" ? "Hata" : "İnceleme"}
                </StatusBadge>
              ),
            },
            {
              key: "detail",
              header: "Neden",
              cell: (row) => classificationDetailLabel(row.detail),
            },
            { key: "n", header: "Ürün", numeric: true, cell: (row) => formatCount(row.count) },
            {
              key: "go",
              header: "Liste",
              cell: (row) => (
                <Link href={`${PRODUCTS}?siniflandirma=${row.state}&durum=all`}>Ürünleri gör</Link>
              ),
            },
          ]}
        />
      </Panel>

      <Panel id="kontrol" title="Kontrol noktaları" flush>
        <DataTable
          rows={monitor.checkpoints}
          rowKey={(row) => `${row.ruleVersion}:${row.scope}`}
          empty={<EmptyPanel title="Kontrol noktası yok" />}
          stack
          columns={[
            { key: "v", header: "Kural", cell: (row) => `v${row.ruleVersion}` },
            {
              key: "scope",
              header: "Kapsam",
              cell: (row) => (row.scope === "all" ? "Tüm katalog" : row.scope),
            },
            {
              key: "scanned",
              header: "Taranan",
              numeric: true,
              cell: (row) => formatCount(row.scanned),
            },
            {
              key: "cat",
              header: "Kategori",
              numeric: true,
              cell: (row) => formatCount(row.categorySet),
            },
            {
              key: "brand",
              header: "Marka",
              numeric: true,
              cell: (row) => formatCount(row.brandSet),
            },
            {
              key: "review",
              header: "İnceleme",
              numeric: true,
              cell: (row) => formatCount(row.review),
            },
            { key: "err", header: "Hata", numeric: true, cell: (row) => formatCount(row.errors) },
            { key: "upd", header: "Son ilerleme", cell: (row) => formatDateOrDash(row.updatedAt) },
            {
              key: "done",
              header: "Tamamlandı",
              cell: (row) => (row.completedAt ? formatDateOrDash(row.completedAt) : "Hayır"),
            },
          ]}
        />
      </Panel>

      <Panel id="kosular" title={`Son koşular · ${jobLabel("classify_products")}`} flush>
        <DataTable
          rows={monitor.runs}
          rowKey={(row) => row.id}
          empty={<EmptyPanel title="Koşu kaydı yok" />}
          stack
          columns={[
            { key: "status", header: "Durum", cell: (row) => <StatusText status={row.status} /> },
            { key: "trigger", header: "Tetikleyen", cell: (row) => row.trigger },
            { key: "start", header: "Başladı", cell: (row) => formatDateOrDash(row.startedAt) },
            {
              key: "dur",
              header: "Süre",
              numeric: true,
              cell: (row) =>
                row.finishedAt
                  ? formatDuration(row.finishedAt.getTime() - row.startedAt.getTime())
                  : "sürüyor",
            },
            { key: "err", header: "Hata özeti", cell: (row) => row.errorSummary ?? "—" },
          ]}
        />
      </Panel>
    </div>
  );
}
