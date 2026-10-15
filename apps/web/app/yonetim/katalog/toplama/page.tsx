import { getCollectionStatus } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KpiCard, KpiGroup, PageHeader, Section } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash } from "../../format.ts";
import { CollectorClient } from "./collector-client.tsx";
import { DiscoveryClient } from "./discovery-client.tsx";

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
  interval: "En az 7 gün aralık dolmadı.",
  month: "Bu takvim ayının koşu hakkı doldu.",
};

export default async function CatalogCollectionPage() {
  const { actor } = await requireCapability("catalog.write");
  const status = await getCollectionStatus(getDatabase(), actor, "hepsiburada");
  const q = status.quota;
  const open = status.openRun;
  const openIsDiscovery = open?.checkpoint?.mode === "discovery";

  return (
    <div className={styles.page}>
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
            label="Bu ay koşu"
            value={`${formatCount(q.runsThisMonth)} / ${formatCount(q.maxRunsPerMonth)}`}
          />
          <KpiCard
            label="Sonraki koşu"
            value={q.nextKind === "initial" ? "İlk yükleme" : "Güncelleme"}
            note={`İstek bütçesi ${formatCount(q.nextMaxRequests)}`}
          />
          <KpiCard label="En az aralık" value={`${q.minIntervalDays} gün`} />
          <KpiCard label="Sonraki izinli zaman" value={formatDateOrDash(q.nextAllowedAt)} />
          <KpiCard
            label="Durum"
            value={q.canStart ? "Başlatılabilir" : "Başlatılamaz"}
            tone={q.canStart ? "neutral" : "warning"}
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
                  maxRequests: open.maxRequests,
                  maxBytes: open.maxBytes,
                  bytesDownloaded: open.bytesDownloaded,
                  approvedBytes: open.downloadApprovedBytes,
                }
              : null
          }
        />
      </Section>

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
