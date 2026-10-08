import {
  type AdminFinding,
  type Capability,
  capabilitiesFor,
  dashboardAttention,
  evaluatePipeline,
  getAdminOverview,
  getOperationsOverview,
  getPipelineEvidence,
  hasCapability,
  MATCH_QUEUE_ALERT_THRESHOLD,
  type MerchantAttentionItem,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../lib/dal.ts";
import styles from "./admin.module.css";
import {
  DataTable,
  FindingList,
  KpiCard,
  KpiGroup,
  PageHeader,
  Panel,
  StatusBadge,
  StatusText,
} from "./admin-ui.tsx";
import {
  attentionLabel,
  formatCost,
  formatCount,
  formatDateOrDash,
  formatDateTime,
  formatUsage,
  hrefWith,
  PIPELINE_STAGE_INFO,
  pipelineStateLabel,
  statusLabel,
} from "./format.ts";

function breakdown(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "Kayıt yok";
  return entries.map(([status, n]) => `${statusLabel(status)} ${formatCount(n)}`).join(" · ");
}

function total(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, n) => sum + n, 0);
}

/** Genel bakışta gösterilen en çok mağaza satırı; liste önem sırasındadır (core). */
const ATTENTION_ROWS = 8;

const PERCENT = new Intl.NumberFormat("tr-TR", { style: "percent", maximumFractionDigits: 1 });

/** Dikkat listesinin önem dağılımı: başlıktaki özet şeridi (yalnızca türetilmiş sayılar). */
function AttentionSummary({ attention }: { attention: readonly AdminFinding[] }) {
  const count = (severity: AdminFinding["severity"]) =>
    attention.filter((finding) => finding.severity === severity).length;
  const critical = count("critical");
  const warning = count("warning");
  const unknown = count("unknown");
  if (attention.length === 0) {
    return <StatusBadge tone="success">Dikkat isteyen bir şey yok</StatusBadge>;
  }
  return (
    <div className={styles.summaryStrip}>
      {critical > 0 ? (
        <StatusBadge tone="critical">{`${formatCount(critical)} kritik`}</StatusBadge>
      ) : null}
      {warning > 0 ? (
        <StatusBadge tone="warning">{`${formatCount(warning)} uyarı`}</StatusBadge>
      ) : null}
      {unknown > 0 ? (
        <StatusBadge tone="neutral">{`${formatCount(unknown)} denetlenemedi`}</StatusBadge>
      ) : null}
    </div>
  );
}

/**
 * Genel bakış (docs/decisions/0039 madde 7, 0051, 0055, 0083): yalnızca
 * veritabanında gerçekten var olan sayılar; her kart sayının temelini
 * (tam sayım / tahmini) taşır ve sorunu teşhis eden sayfaya gider — ama
 * yalnızca izleyicinin açabildiği sayfaya. "Şimdi dikkat isteyenler"
 * mevcut durumdan türetilir (kalıcı alarm yok). Yönetici işletim
 * bulgularını da görür; moderatör bugün gördüğü sinyallerden (mağazalar,
 * boru hattı, eşleştirme kuyruğu) türetilen listeyi.
 */
export default async function AdminOverviewPage() {
  const { user, actor } = await requireCapability("admin.access");
  const db = getDatabase();
  const can = (capability: Capability) => hasCapability(user.role, capability);
  const [overview, pipelineRaw, ops] = await Promise.all([
    getAdminOverview(db, actor),
    getPipelineEvidence(db, actor),
    can("operations.read") ? getOperationsOverview(db, actor) : Promise.resolve(null),
  ]);
  const pipeline = evaluatePipeline(pipelineRaw, overview.generatedAt);
  const attention = dashboardAttention({
    now: overview.generatedAt,
    merchants: overview.ingest.attention,
    pipeline,
    pendingMatches: overview.pendingMatches,
    ops,
  });
  const linkIf = (capability: Capability, href: string) => (can(capability) ? href : null);

  const failedRuns = overview.ingest.runsLast24h.failed ?? 0;
  const failedLinks = overview.linkRequests7d.failed ?? 0;
  const cost24h = formatCost(overview.apiUsage.last24h);
  const cost7d = formatCost(overview.apiUsage.last7d);
  const pipelineIssues = pipeline.filter(
    (stage) => stage.state === "warning" || stage.state === "behind" || stage.state === "unknown",
  );
  const search = overview.textSearch7d;
  const queueOverThreshold = overview.pendingMatches > MATCH_QUEUE_ALERT_THRESHOLD;
  const attentionMerchants = overview.ingest.attention;
  const shownMerchants = attentionMerchants.slice(0, ATTENTION_ROWS);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Genel bakış"
        description={`Son güncelleme ${formatDateTime(overview.generatedAt)} · yalnızca kayıtlı veri; tahmin edilen değerler işaretlidir.`}
        actions={<AttentionSummary attention={attention} />}
      />

      <Panel
        id="simdi-dikkat"
        title="Şimdi dikkat isteyenler"
        description="Mevcut durumdan türetilir; yalnızca kritik, uyarı ve denetlenemeyen bulgular."
        actions={
          can("operations.read") ? (
            <Link href="/yonetim/islemler">Tüm denetimler (sistem sağlığı)</Link>
          ) : null
        }
      >
        <FindingList
          findings={attention}
          allowed={capabilitiesFor(user.role)}
          empty="Şu an dikkat isteyen bir şey yok."
        />
      </Panel>

      <KpiGroup title="Katalog ve eşleştirme">
        <KpiCard
          label="Bekleyen eşleştirme"
          value={formatCount(overview.pendingMatches)}
          tone={queueOverThreshold ? "warning" : "neutral"}
          status={queueOverThreshold ? `${MATCH_QUEUE_ALERT_THRESHOLD} eşiğinin üstünde` : null}
          basis="count"
          href={linkIf("matching.review", "/yonetim/eslestirme")}
        />
        <KpiCard
          label="Eşleşmemiş aktif teklif"
          value={formatCount(overview.unmatchedOffers)}
          basis="count"
          href={linkIf("catalog.read", "/yonetim/katalog/teklifler?durum=unmatched")}
        />
        <KpiCard
          label="Aktif mağaza"
          value={`${formatCount(overview.merchants.active)} / ${formatCount(overview.merchants.total)}`}
          note="Aktif / toplam"
          basis="count"
          href={linkIf("merchant.read", "/yonetim/magazalar?durum=aktif")}
        />
        <KpiCard
          label="Veri toplama koşuları (24 saat)"
          value={formatCount(total(overview.ingest.runsLast24h))}
          note={breakdown(overview.ingest.runsLast24h)}
          tone={failedRuns > 0 ? "warning" : "neutral"}
          status={failedRuns > 0 ? `${formatCount(failedRuns)} başarısız koşu` : null}
          href={linkIf(
            "ingest.read",
            failedRuns > 0 ? "/yonetim/ingest?durum=failed" : "/yonetim/ingest",
          )}
        />
      </KpiGroup>

      <KpiGroup title="Arama ve AI">
        <KpiCard
          label="Metin araması (7 gün)"
          value={formatCount(search.searches)}
          note={
            search.searches > 0
              ? `Sonuçsuz ${PERCENT.format(search.zeroResults / search.searches)} · yedek listeye düşen ${formatCount(search.fallbacks)}`
              : "Son 7 günde metin araması yok"
          }
          basis="count"
          href={linkIf("dictionary.write", "/yonetim/sozluk?gun=7&sorun=zero")}
        />
        <KpiCard
          label="Link araması (7 gün)"
          value={formatCount(total(overview.linkRequests7d))}
          note={breakdown(overview.linkRequests7d)}
          tone={failedLinks > 0 ? "warning" : "neutral"}
          basis="count"
          href={linkIf(
            "diagnostics.read",
            failedLinks > 0 ? "/yonetim/arama/link?durum=failed" : "/yonetim/arama/link",
          )}
        />
        <KpiCard
          label="Görsel yükleme (7 gün)"
          value={formatCount(total(overview.imageUploads7d))}
          note={breakdown(overview.imageUploads7d)}
          basis="count"
          href={linkIf("diagnostics.read", "/yonetim/arama/gorsel")}
        />
        <KpiCard
          label="Model maliyeti (24 saat)"
          value={cost24h.value}
          note={[cost24h.note, `7 gün: ${cost7d.value} · ${formatUsage(overview.apiUsage.last7d)}`]
            .filter(Boolean)
            .join(" · ")}
          tone={cost24h.note !== null ? "warning" : "neutral"}
          basis="estimate"
          href={linkIf("operations.read", "/yonetim/islemler#maliyet")}
        />
      </KpiGroup>

      <KpiGroup title="Kullanıcılar">
        <KpiCard
          label="Yeni kullanıcı (7 gün)"
          value={formatCount(overview.newUsers7d)}
          basis="count"
          href={linkIf("users.read", "/yonetim/kullanicilar")}
        />
      </KpiGroup>

      <div className={styles.panelGrid}>
        <Panel
          id="boru-hatti"
          title="Veri boru hattı"
          description="Geride kalan ya da denetlenemeyen aşamalar."
          footer={
            can("operations.read") ? (
              <Link href="/yonetim/islemler#boru-hatti">Tüm aşamalar ve çalıştırma komutları</Link>
            ) : null
          }
        >
          {pipelineIssues.length === 0 ? (
            <p className={styles.muted}>Tüm aşamaların son kanıtı güncel ya da henüz veri yok.</p>
          ) : (
            <ul className={styles.list}>
              {pipelineIssues.map((stage) => (
                <li key={stage.stage} className={styles.row}>
                  <StatusBadge tone={stage.state === "warning" ? "critical" : "warning"}>
                    {pipelineStateLabel(stage.state)}
                  </StatusBadge>
                  <span>{PIPELINE_STAGE_INFO[stage.stage].label}</span>
                  <span
                    className={styles.meta}
                  >{`son kanıt ${formatDateOrDash(stage.lastAt)}`}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          id="dikkat"
          title="Dikkat gerektiren mağazalar"
          description="Yalnızca aktif mağazalar. Kısmi koşu tek başına sorun sayılmaz (veri yazılmıştır)."
          flush={shownMerchants.length > 0}
          footer={
            attentionMerchants.length > shownMerchants.length ? (
              <>
                {`${formatCount(shownMerchants.length)} / ${formatCount(attentionMerchants.length)} mağaza gösteriliyor (önem sırasıyla). `}
                {can("merchant.read") ? (
                  <Link href="/yonetim/magazalar?durum=aktif">Tüm aktif mağazalar</Link>
                ) : null}
              </>
            ) : null
          }
        >
          <DataTable<MerchantAttentionItem>
            rows={shownMerchants}
            rowKey={(item) => item.merchantId}
            stack
            empty={<p className={styles.muted}>Dikkat gerektiren aktif mağaza yok.</p>}
            columns={[
              {
                key: "magaza",
                header: "Mağaza",
                cell: (item) =>
                  can("merchant.read") ? (
                    <Link href={`/yonetim/magazalar/${item.merchantSlug}`}>
                      {item.merchantName}
                    </Link>
                  ) : (
                    item.merchantName
                  ),
              },
              {
                key: "durum",
                header: "Durum",
                cell: (item) => (
                  <div className={styles.list}>
                    {item.states.map((state) => (
                      <span key={state} className={styles.statusBad}>
                        {attentionLabel(state)}
                      </span>
                    ))}
                    {item.failuresSinceSuccess > 1 ? (
                      <span className={styles.meta}>
                        {`${formatCount(item.failuresSinceSuccess)} başarısız koşu (son başarılıdan beri)`}
                      </span>
                    ) : null}
                  </div>
                ),
              },
              {
                key: "kosu",
                header: "Son koşu",
                cell: (item) =>
                  item.lastRun ? (
                    <div className={styles.list}>
                      <StatusText status={item.lastRun.status} />
                      {can("ingest.read") ? (
                        <Link
                          className={styles.meta}
                          href={hrefWith("/yonetim/ingest", { magaza: item.merchantId })}
                        >
                          {formatDateTime(item.lastRun.startedAt)}
                        </Link>
                      ) : (
                        <span className={styles.meta}>
                          {formatDateTime(item.lastRun.startedAt)}
                        </span>
                      )}
                    </div>
                  ) : (
                    "Hiç çalışmadı"
                  ),
              },
              {
                key: "yenileme",
                header: "Son yenileme",
                cell: (item) => formatDateOrDash(item.lastGoodAt),
              },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}
