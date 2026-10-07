import {
  type Capability,
  capabilitiesFor,
  dashboardAttention,
  evaluatePipeline,
  getAdminOverview,
  getOperationsOverview,
  getPipelineEvidence,
  hasCapability,
  MATCH_QUEUE_ALERT_THRESHOLD,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../lib/dal.ts";
import styles from "./admin.module.css";
import { FindingList, StatusText, Tile } from "./admin-ui.tsx";
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

/**
 * docs/decisions/0039 madde 7: yalnızca veritabanında gerçekten var olan sayılar.
 * Karar 0051: her kart sorunu teşhis eden sayfaya gider — ama yalnızca
 * izleyicinin açabildiği sayfaya; kartların kendisi (görünürlük) değişmez.
 * Karar 0055: "Şimdi dikkat isteyenler" mevcut durumdan türetilir (kalıcı
 * alarm yok). Yönetici işletim bulgularını da görür; moderatör bugün gördüğü
 * sinyallerden (mağazalar, boru hattı, eşleştirme kuyruğu) türetilen listeyi.
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

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Genel bakış</h1>
        <p className={styles.muted}>{`Son güncelleme ${formatDateTime(overview.generatedAt)}`}</p>
      </header>

      <section className={styles.pageHeader} aria-labelledby="simdi-dikkat">
        <h2 id="simdi-dikkat" className={styles.sectionTitle}>
          Şimdi dikkat isteyenler
        </h2>
        <FindingList
          findings={attention}
          allowed={capabilitiesFor(user.role)}
          empty="Şu an dikkat isteyen bir şey yok."
        />
        {can("operations.read") ? (
          <p className={styles.muted}>
            <Link href="/yonetim/islemler">Tüm denetimler (sistem sağlığı)</Link>
          </p>
        ) : null}
      </section>

      <section className={styles.tiles} aria-label="Katalog ve kuyruk">
        <Tile
          label="Bekleyen eşleştirme"
          value={formatCount(overview.pendingMatches)}
          note={
            overview.pendingMatches > MATCH_QUEUE_ALERT_THRESHOLD
              ? `${MATCH_QUEUE_ALERT_THRESHOLD} eşiğinin üstünde`
              : undefined
          }
          warning={overview.pendingMatches > MATCH_QUEUE_ALERT_THRESHOLD}
          href={linkIf("matching.review", "/yonetim/eslestirme")}
        />
        <Tile
          label="Eşleşmemiş aktif teklif"
          value={formatCount(overview.unmatchedOffers)}
          href={linkIf("catalog.read", "/yonetim/katalog/teklifler?durum=unmatched")}
        />
        <Tile
          label="Aktif mağaza"
          value={`${formatCount(overview.merchants.active)} / ${formatCount(overview.merchants.total)}`}
          href={linkIf("merchant.read", "/yonetim/magazalar?durum=aktif")}
        />
        <Tile
          label="Yeni kullanıcı (7 gün)"
          value={formatCount(overview.newUsers7d)}
          href={linkIf("users.read", "/yonetim/kullanicilar")}
        />
      </section>

      <section className={styles.tiles} aria-label="Kullanıcı akışları ve maliyet">
        <Tile
          label="Veri toplama koşuları (24 saat)"
          value={formatCount(total(overview.ingest.runsLast24h))}
          note={breakdown(overview.ingest.runsLast24h)}
          warning={failedRuns > 0}
          href={linkIf(
            "ingest.read",
            failedRuns > 0 ? "/yonetim/ingest?durum=failed" : "/yonetim/ingest",
          )}
        />
        <Tile
          label="Link araması (7 gün)"
          value={formatCount(total(overview.linkRequests7d))}
          note={breakdown(overview.linkRequests7d)}
          href={linkIf(
            "diagnostics.read",
            failedLinks > 0 ? "/yonetim/arama/link?durum=failed" : "/yonetim/arama/link",
          )}
        />
        <Tile
          label="Görsel yükleme (7 gün)"
          value={formatCount(total(overview.imageUploads7d))}
          note={breakdown(overview.imageUploads7d)}
          href={linkIf("diagnostics.read", "/yonetim/arama/gorsel")}
        />
        <Tile
          label="Model maliyeti (24 saat)"
          value={cost24h.value}
          note={[cost24h.note, `7 gün: ${cost7d.value} · ${formatUsage(overview.apiUsage.last7d)}`]
            .filter(Boolean)
            .join(" · ")}
          warning={cost24h.note !== null}
          href={linkIf("operations.read", "/yonetim/islemler#maliyet")}
        />
      </section>

      <section className={styles.pageHeader} aria-labelledby="boru-hatti">
        <h2 id="boru-hatti" className={styles.sectionTitle}>
          Veri boru hattı
        </h2>
        {pipelineIssues.length === 0 ? (
          <p className={styles.muted}>Tüm aşamaların son kanıtı güncel ya da henüz veri yok.</p>
        ) : (
          <ul className={styles.list}>
            {pipelineIssues.map((stage) => (
              <li key={stage.stage}>
                <span className={stage.state === "warning" ? styles.statusBad : styles.statusWarn}>
                  {`${PIPELINE_STAGE_INFO[stage.stage].label}: ${pipelineStateLabel(stage.state)}`}
                </span>
                <span className={styles.meta}>
                  {` · son kanıt ${formatDateOrDash(stage.lastAt)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {can("operations.read") ? (
          <p className={styles.muted}>
            <Link href="/yonetim/islemler#boru-hatti">Tüm aşamalar ve çalıştırma komutları</Link>
          </p>
        ) : null}
      </section>

      <section className={styles.pageHeader} aria-labelledby="dikkat">
        <h2 id="dikkat" className={styles.sectionTitle}>
          Dikkat gerektiren mağazalar
        </h2>
        <p className={styles.muted}>
          Yalnızca aktif mağazalar. Kısmi koşu tek başına sorun sayılmaz (veri yazılmıştır).
        </p>
        {overview.ingest.attention.length === 0 ? (
          <p className={styles.muted}>Dikkat gerektiren aktif mağaza yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Mağaza</th>
                  <th scope="col">Durum</th>
                  <th scope="col">Son koşu</th>
                  <th scope="col">Son yenileme</th>
                </tr>
              </thead>
              <tbody>
                {overview.ingest.attention.map((item) => (
                  <tr key={item.merchantId}>
                    <td>
                      {can("merchant.read") ? (
                        <Link href={`/yonetim/magazalar/${item.merchantSlug}`}>
                          {item.merchantName}
                        </Link>
                      ) : (
                        item.merchantName
                      )}
                    </td>
                    <td>
                      {item.states.map((state) => (
                        <span key={state} className={styles.statusBad} style={{ display: "block" }}>
                          {attentionLabel(state)}
                        </span>
                      ))}
                      {item.failuresSinceSuccess > 1 ? (
                        <span className={styles.meta}>
                          {`${formatCount(item.failuresSinceSuccess)} başarısız koşu (son başarılıdan beri)`}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {item.lastRun ? (
                        <>
                          <StatusText status={item.lastRun.status} />
                          <br />
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
                        </>
                      ) : (
                        "Hiç çalışmadı"
                      )}
                    </td>
                    <td>{formatDateOrDash(item.lastGoodAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.pageHeader} aria-labelledby="araclar">
        <h2 id="araclar" className={styles.sectionTitle}>
          Araçlar
        </h2>
        <ul className={styles.list}>
          <li>
            <Link href="/yonetim/eslestirme">Eşleştirme kuyruğu</Link>
          </li>
          <li>
            <Link href="/yonetim/sozluk">Sözlük</Link>
          </li>
          <li>
            <Link href="/yonetim/magazalar">Mağazalar</Link>
          </li>
          <li>
            <Link href="/yonetim/arama/tani">Arama tanısı</Link>
          </li>
        </ul>
      </section>

      <p className={styles.muted}>
        Arama sayısı ve sonuçsuz arama oranı burada yok: arama günlüğü henüz tutulmuyor.
      </p>
    </div>
  );
}
