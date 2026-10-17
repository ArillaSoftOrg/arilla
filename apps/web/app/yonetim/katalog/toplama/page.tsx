import { getCatalogFunnel, getCollectionStatus } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KpiCard, KpiGroup, PageHeader, Section } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash } from "../../format.ts";
import { CatalogFunnelSection } from "./catalog-funnel-section.tsx";
import { CollectorClient } from "./collector-client.tsx";
import { DiscoveryClient } from "./discovery-client.tsx";
import { DocumentLoadGuard } from "./document-load-guard.tsx";

/**
 * Hepsiburada katalog toplama (karar 0117). Toplama yöneticinin KENDİ
 * tarayıcısında çalışır; kullanıcılar Hepsiburada'ya istek göndermez, arama
 * hazır PostgreSQL kataloğundan yanıtlanır. Kota sunucuda zorunludur.
 */
export const dynamic = "force-dynamic";

const BASIS_TEXT: Record<string, string> = {
  verbal_reported: "kullanıcının bildirdiği sözlü izin",
  written_email_reported: "kullanıcının bildirdiği yazılı (e-posta) izin",
  declared_extended: "kullanıcının bildirdiği genişletilmiş kapsam",
  written_agreement: "yazılı sözleşme",
  public_feed: "herkese açık besleme",
};

const BLOCKED_TEXT: Record<string, string> = {
  disabled: "Kaynak kapalı (collection_source.enabled = false).",
  open_run: "Açık bir toplama koşusu var; sürdürülebilir.",
  interval: "Koşular arası en az aralık dolmadı.",
  month: "Bu takvim ayının koşu hakkı doldu.",
  daily_requests: "Bugünkü HTTP isteği hakkı doldu; UTC gün dönümünde yenilenir.",
  monthly_requests: "Bu ayın HTTP isteği hakkı doldu; UTC ay başında yenilenir.",
  monthly_products: "Bu ayın ürün hakkı doldu; UTC ay başında yenilenir.",
};

function limitText(used: number, limit: number | null): string {
  return limit === null
    ? `${formatCount(used)} / sınırsız`
    : `${formatCount(used)} / ${formatCount(limit)}`;
}

export default async function CatalogCollectionPage() {
  const { actor } = await requireCapability("catalog.write");
  const db = getDatabase();
  const [status, funnel] = await Promise.all([
    getCollectionStatus(db, actor, "hepsiburada"),
    getCatalogFunnel(db, actor, "hepsiburada"),
  ]);
  const q = status.quota;
  const open = status.openRun;
  const openIsDiscovery = open?.checkpoint?.mode === "discovery";

  return (
    <div className={styles.page}>
      <DocumentLoadGuard />
      <PageHeader title="Katalog toplama: Hepsiburada">
        <p className={styles.muted}>
          Ürünler bu sayfadaki tarayıcıdan okunur ve kataloğa aktarılır. İzin dayanağı:{" "}
          <strong>{BASIS_TEXT[q.permissionBasis] ?? q.permissionBasis}</strong>. Belgeler bağımsız
          incelenmedi. {q.permissionNote}
        </p>
      </PageHeader>

      <Section id="kota" title="Kota">
        <KpiGroup label="Kota">
          <KpiCard
            label="Bugün HTTP isteği (UTC)"
            value={limitText(q.usage.day.requests, q.limits.dailyMaxRequests)}
            note={`Yenilenme: ${formatDateOrDash(q.usage.dayResetsAt)}`}
          />
          <KpiCard
            label="Bu ay HTTP isteği"
            value={limitText(q.usage.month.requests, q.limits.monthlyMaxRequests)}
            note={`Yenilenme: ${formatDateOrDash(q.usage.monthResetsAt)}`}
          />
          <KpiCard
            label="Bu ay işlenen ürün"
            value={limitText(q.usage.month.products, q.limits.monthlyMaxProducts)}
          />
          <KpiCard
            label="Sonraki koşu"
            value={q.nextKind === "initial" ? "İlk yükleme" : "Güncelleme"}
            note={`Koşu başına istek bütçesi ${formatCount(q.nextMaxRequests)}`}
          />
          <KpiCard
            label="Durum"
            value={
              q.canStart ? "Başlatılabilir" : q.canResume ? "Devam edilebilir" : "Başlatılamaz"
            }
            tone={q.canStart || q.canResume ? "neutral" : "warning"}
            note={q.blockedBy ? BLOCKED_TEXT[q.blockedBy] : undefined}
          />
        </KpiGroup>
      </Section>

      <Section
        id="toplayici"
        title="Toplayıcı"
        description="Sorgu listesi senin verdiğin terimlerdir; kaynağın tüm kataloğuna erişim varsayılmaz. Her kaynak isteği arada bekleyerek atılır; 403, 429 ya da doğrulama sayfasında koşu durur."
      >
        <CollectorClient
          source="hepsiburada"
          canStart={q.canStart}
          openRun={
            status.openRun && !openIsDiscovery
              ? {
                  id: status.openRun.id,
                  requestsMade: status.openRun.requestsMade,
                  maxRequests: status.openRun.maxRequests,
                  expiresAt: status.openRun.expiresAt.toISOString(),
                  checkpoint: status.openRun.checkpoint,
                }
              : null
          }
        />
      </Section>

      <Section
        id="kesif"
        title="Sitemap keşfi (fiyatsız kimlikler)"
        description="Ürün sitemap dosyaları tek tek, bekleyerek indirilir; yalnızca ürün kimliği, adres, görsel ve (varsa) ad kaydedilir. Fiyat yoktur ve uydurulmaz. İndirme için bayt onayı gerekir; onay olmadan hiçbir bayt kabul edilmez. Keşfedilen sayı katalogun tamamı olarak sunulmaz."
      >
        <DiscoveryClient
          source="hepsiburada"
          canStart={q.canStart}
          openRun={
            open && openIsDiscovery
              ? {
                  id: open.id,
                  requestsMade: open.requestsMade,
                  requestsReserved: open.requestsReserved,
                  maxRequests: open.maxRequests,
                  maxBytes: open.maxBytes,
                  bytesDownloaded: open.bytesDownloaded,
                  approvedBytes: open.downloadApprovedBytes,
                }
              : null
          }
        />
      </Section>

      <CatalogFunnelSection funnel={funnel} />

      <Section id="gecmis" title="Son koşular">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Koşu</th>
                <th>Durum</th>
                <th>Başlangıç</th>
                <th className="num">İstek</th>
                <th className="num">Benzersiz ürün</th>
              </tr>
            </thead>
            <tbody>
              {status.recentRuns.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.status}</td>
                  <td>{formatDateOrDash(r.reservedAt)}</td>
                  <td className="num">{formatCount(r.requestsMade)}</td>
                  <td className="num">
                    {typeof r.summary?.uniqueRecords === "number"
                      ? formatCount(r.summary.uniqueRecords)
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
