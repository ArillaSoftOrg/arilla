import { getCollectionStatus, isSourceFlagEnabled } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/dal.ts";
import styles from "../../../admin.module.css";
import { KpiCard, KpiGroup, PageHeader, Section } from "../../../admin-ui.tsx";
import { formatCount, formatDateOrDash, formatPermissionBasis } from "../../../format.ts";
import { TrendyolRelayClient } from "./trendyol-client.tsx";

/**
 * Trendyol katalog toplama (karar 0118). Trendyol CORS açmadığı için sayfaları bu sunucu ya da
 * bu sayfa çekmez: yönetici Trendyol sayfasını KENDİ açar, eklenti açık sayfadaki veriyi okur
 * (ek ağ isteği yok) ve buraya iletir; bu sayfa kimlikli yönetim API'sine gönderir. Kota ve
 * istek bütçesi veritabanında zorunludur. `TRENDYOL_COLLECTION_ENABLED` kapalıyken sayfa yoktur.
 */
export const dynamic = "force-dynamic";

const BLOCKED_TEXT: Record<string, string> = {
  disabled: "Kaynak kapalı (collection_source.enabled = false).",
  open_run: "Açık bir toplama koşusu var; sürdürülebilir.",
  interval: "En az 7 gün aralık dolmadı.",
  month: "Bu takvim ayının koşu hakkı doldu.",
};

export default async function TrendyolCollectionPage() {
  const { actor } = await requireCapability("catalog.write");
  if (!isSourceFlagEnabled("trendyol")) notFound();
  const status = await getCollectionStatus(getDatabase(), actor, "trendyol");
  const q = status.quota;

  return (
    <div className={styles.page}>
      <PageHeader title="Katalog toplama: Trendyol">
        <p className={styles.muted}>
          İzin dayanağı: <strong>{formatPermissionBasis(q.permissionBasis)}</strong>.{" "}
          {q.permissionNote}
        </p>
      </PageHeader>

      <Section id="kota" title="Kota">
        <KpiGroup label="Kota">
          <KpiCard
            label="Bu ay koşu"
            value={`${formatCount(q.runsThisMonth)} / ${formatCount(q.maxRunsPerMonth)}`}
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
        id="aktarim"
        title="Aktarım"
        description="Okunan: ürün kimliği, ad, satış fiyatı, görseller, kanonik bağlantı, ana satıcı, fiyatın ait olduğu beden. Okunmayan: diğer satıcıların teklifleri, stok, satıcı kişisel bilgileri, yorumlar. Sepet indirimi satış fiyatı sayılmaz. Her açılan ürün ya da liste sayfası bir istektir."
      >
        <TrendyolRelayClient
          canStart={q.canStart}
          openRun={
            status.openRun
              ? {
                  id: status.openRun.id,
                  requestsMade: status.openRun.requestsMade,
                  maxRequests: status.openRun.maxRequests,
                  expiresAt: status.openRun.expiresAt.toISOString(),
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
                <th className="num">Sayfa (istek)</th>
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
