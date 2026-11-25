import { getCollectionSchedule, isSourceFlagEnabled } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/dal.ts";
import styles from "../../../admin.module.css";
import { KpiCard, KpiGroup, PageHeader, Section } from "../../../admin-ui.tsx";
import { formatCount, formatDateOrDash, formatPermissionBasis } from "../../../format.ts";
import { ScheduleForm } from "./schedule-form.tsx";
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
  daily_requests: "Bugünkü HTTP isteği hakkı doldu; UTC gün dönümünde yenilenir.",
  monthly_requests: "Bu ayın HTTP isteği hakkı doldu; UTC ay başında yenilenir.",
  monthly_products: "Bu ayın ürün hakkı doldu; UTC ay başında yenilenir.",
};

const SCHEDULE_WAIT_TEXT: Record<string, string> = {
  flag_off: "Zamanlayıcı ortam bayrağı kapalı (TRENDYOL_SCHEDULE_ENABLED).",
  schedule_off: "Zamanlama kapalı.",
  source_disabled: "Kaynak kapalı (collection_source.enabled = false).",
  no_targets: "Hedef adres yok.",
  open_run: "Elle açılmış bir koşu var; zamanlayıcı dokunmaz.",
  interval: "En az 7 gün aralık dolmadı.",
  month: "Bu takvim ayının koşu hakkı doldu.",
  volume: "Hacim kotası doldu.",
};

const OUTCOME_TEXT: Record<string, string> = {
  completed: "Tamamlandı",
  budget: "İstek bütçesi doldu (kısmi)",
  aborted: "İptal edildi",
  blocked: "Sayfa yapısı yok / engel: durdu",
  interrupted: "Yarıda kaldı (sayfa ya da tarayıcı kapandı)",
  start_refused: "Kota başlatmayı reddetti",
  error: "Hata",
};

export default async function TrendyolCollectionPage({
  searchParams,
}: {
  searchParams: Promise<{ otomatik?: string }>;
}) {
  const { actor } = await requireCapability("catalog.write");
  if (!isSourceFlagEnabled("trendyol")) notFound();
  const params = await searchParams;
  const { schedule, status } = await getCollectionSchedule(getDatabase(), actor, "trendyol");
  const q = status.quota;
  const decision = schedule.decision;
  // Otomatik kip yalniz zamanlayici bayragi acikken; yoksa sayfa elle kullanim gibi davranir.
  const autoMode = params.otomatik === "1" && schedule.flagEnabled;

  return (
    <div className={styles.page}>
      <PageHeader title="Katalog toplama: Trendyol">
        <p className={styles.muted}>
          İzin dayanağı: <strong>{formatPermissionBasis(q.permissionBasis)}</strong>. Belgeler
          bağımsız incelenmedi. {q.permissionNote}
        </p>
      </PageHeader>

      <Section id="kota" title="Kota">
        <KpiGroup label="Kota">
          <KpiCard
            label="Bu ay koşu"
            value={`${formatCount(q.runsThisMonth)} / ${
              q.maxRunsPerMonth === null ? "sınırsız" : formatCount(q.maxRunsPerMonth)
            }`}
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
        id="zamanlama"
        title="Zamanlanmış toplama"
        description="Eklenti, sonraki izinli zamanda bu sayfayı yöneticinin tarayıcısında açar; sayfa sunucuya kotayı sorar ve izin varsa kayıtlı adresleri tek sekmede, ayarlanan aralıkla açtırır. Sunucu Trendyol'a istek atmaz. Kota (7 gün / ayda 4, ilk yükleme dahil) değişmez."
      >
        <KpiGroup label="Zamanlama">
          <KpiCard
            label="Durum"
            value={
              decision.action === "start"
                ? "Koşu zamanı geldi"
                : decision.action === "interrupted"
                  ? "Yarım koşu kapatılacak"
                  : "Bekliyor"
            }
            tone={schedule.lastFailed ? "warning" : "neutral"}
            note={decision.action === "wait" ? SCHEDULE_WAIT_TEXT[decision.reason] : undefined}
          />
          <KpiCard
            label="Sonraki yoklama"
            value={formatDateOrDash(decision.action === "wait" ? decision.nextCheckAt : null)}
          />
          <KpiCard label="Son deneme" value={formatDateOrDash(schedule.lastAttemptAt)} />
          <KpiCard
            label="Son sonuç"
            value={schedule.lastOutcome ? (OUTCOME_TEXT[schedule.lastOutcome] ?? "-") : "-"}
            tone={schedule.lastFailed ? "warning" : "neutral"}
            note={schedule.lastErrorCode ?? undefined}
          />
        </KpiGroup>
        <ScheduleForm
          enabled={schedule.enabled}
          targetUrls={schedule.targetUrls}
          paceSeconds={schedule.paceSeconds}
          flagEnabled={schedule.flagEnabled}
        />
      </Section>

      <Section
        id="aktarim"
        title="Aktarım"
        description="Okunan: ürün kimliği, ad, marka, satış fiyatı, görseller, kanonik bağlantı, ana satıcı, fiyatın ait olduğu beden ve onun barkodu. Okunmayan: diğer satıcıların teklifleri, stok, satıcı kişisel bilgileri, yorumlar. Sepet indirimi satış fiyatı sayılmaz. Her açılan ürün ya da liste sayfası bir istektir."
      >
        <TrendyolRelayClient
          autoMode={autoMode}
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
                <th>Son zamanlanmış</th>
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
                  <td>{r.id === schedule.lastRunId ? "Evet" : "-"}</td>
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
