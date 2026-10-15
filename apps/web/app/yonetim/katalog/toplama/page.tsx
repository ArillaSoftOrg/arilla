import { getDiscoveryStatus, listProblemUnits } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KpiCard, KpiGroup, PageHeader, Section } from "../../admin-ui.tsx";
import { formatBytes, formatCount, formatDateOrDash } from "../../format.ts";
import { CollectorClient } from "./collector-client.tsx";
import { DiscoveryClient } from "./discovery-client.tsx";

/**
 * Hepsiburada katalog toplama (karar 0117, 0120). İki ayrı akış:
 *  1. Sitemap keşfi: ürün kimliği, adı, görseli ve adresi (fiyat YOK). İlk aktarım haftalık
 *     kotadan ayrıdır; haftalık yenileme operasyon başına tek hak harcar.
 *  2. Liste toplayıcı: doğrulanmış fiyat (ara depo -> `hb-merge`); haftalık kotayı kullanır.
 * Her iki akış da yöneticinin KENDİ tarayıcısında ve internet bağlantısında çalışır; kullanıcılar
 * Hepsiburada'ya istek göndermez. Kota ve bütçeler sunucuda zorunludur.
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
  open_run: "Açık bir koşu var; sürdürülebilir.",
  interval: "En az 7 gün aralık dolmadı.",
  month: "Bu takvim ayının hakları doldu.",
};

const OPERATION_STATUS: Record<string, string> = {
  open: "Açık",
  paused: "Duraklatıldı",
  blocked: "Engel nedeniyle durdu",
  completed: "Tamamlandı",
  cancelled: "İptal edildi",
  expired: "Kota penceresi doldu",
};

const KIND_TEXT: Record<string, string> = {
  initial_import: "İlk aktarım",
  weekly_refresh: "Haftalık yenileme",
};

const REMOVAL_TEXT: Record<string, string> = {
  not_applicable: "-",
  pending: "Değerlendirme bekliyor",
  done: "Yapıldı",
  skipped_partial: "Yapılmadı (yarım tarama)",
};

export default async function CatalogCollectionPage() {
  const { actor } = await requireCapability("catalog.write");
  const db = getDatabase();
  const status = await getDiscoveryStatus(db, actor, "hepsiburada");
  const q = status.refreshQuota;
  const op = status.active;
  const units = status.activeUnits;
  const problems = op ? await listProblemUnits(db, actor, op.id, 50) : [];
  const t = status.tally;
  const p = status.policy;

  return (
    <div className={styles.page}>
      <PageHeader title="Katalog toplama: Hepsiburada">
        <p className={styles.muted}>
          İzin dayanağı: <strong>{BASIS_TEXT[q.permissionBasis] ?? q.permissionBasis}</strong>.
          Belgeler bağımsız incelenmedi. {q.permissionNote}
        </p>
        <p className={styles.muted}>
          <strong>Bu sayfadaki aktarımlar senin internet bağlantını kullanır.</strong> Dosyalar bu
          tarayıcıya iner, burada ayrıştırılır ve yalnızca ürün kimliği, adı, görseli ve adresi
          sunucuya gönderilir. Mobil veriyle büyük aktarım başlatma; büyük aktarım varsayılan olarak
          kapalıdır.
        </p>
      </PageHeader>

      <Section
        id="kesif"
        title="Katalog keşfi (sitemap)"
        description="Keşif kataloğu fiyat içermez. Fiyat yalnızca doğrulanmış kaynak kaydından gelir; fiyatı olmayan ürüne fiyat yazılmaz."
      >
        <KpiGroup label="Keşif">
          <KpiCard label="Keşfedilen benzersiz ürün" value={formatCount(t.itemsTotal)} />
          <KpiCard
            label="Hedef göstergesi"
            value={`${formatCount(t.itemsTotal)} / ${formatCount(p.targetUniqueItems)}`}
            note="Keşif hedefi; katalog tamamlanma yüzdesi değildir ve bir üst sınır değildir."
          />
          <KpiCard label="Doğrulanmış fiyatlı" value={formatCount(t.itemsPriced)} />
          <KpiCard label="Fiyatı bekleyen" value={formatCount(t.itemsUnpriced)} />
          <KpiCard
            label="Yayında (fiyatsız teklif)"
            value={formatCount(t.itemsPublished)}
            note={`Son yeniden sayım: ${formatDateOrDash(t.recountedAt)}`}
          />
          <KpiCard label="Kaldırılmış (doğrulanmış)" value={formatCount(t.itemsRemoved)} />
        </KpiGroup>
        <KpiGroup label="Bütçe ve trafik">
          <KpiCard
            label="Son 24 saat istek"
            value={`${formatCount(status.requestsLast24h)} / ${formatCount(p.dailyMaxRequests)}`}
          />
          <KpiCard label="İstekler arası en az" value={`${p.minRequestIntervalMs / 1000} sn`} />
          <KpiCard
            label="İlk aktarım bütçesi"
            value={`${formatCount(p.initialMaxRequests)} istek`}
            note={`${formatBytes(p.initialMaxBytes)} açılmış veri`}
          />
          <KpiCard
            label="Yenileme bütçesi"
            value={`${formatCount(p.refreshMaxRequests)} istek`}
            note={`${formatBytes(p.refreshMaxBytes)} açılmış veri`}
          />
          <KpiCard
            label="Keşif durumu"
            value={p.enabled ? "Açık" : "Kapalı"}
            tone={p.enabled ? "neutral" : "warning"}
            note={
              p.enabled ? undefined : "discovery_source_policy.enabled = false (sahip rol açar)."
            }
          />
        </KpiGroup>
      </Section>

      <Section id="operasyonlar" title="İlk aktarım ve haftalık yenileme">
        <KpiGroup label="Durum">
          <KpiCard
            label="İlk aktarım"
            value={
              status.initialImport
                ? (OPERATION_STATUS[status.initialImport.status] ?? status.initialImport.status)
                : "Başlatılmadı"
            }
            note="Haftalık yenileme hakkı harcamaz; kendi bütçesiyle sınırlıdır."
          />
          <KpiCard
            label="Haftalık yenileme hakkı (bu ay)"
            value={`${formatCount(q.runsThisMonth)} / ${formatCount(q.maxRunsPerMonth)}`}
            note="Yalnızca haftalık yenilemeler ve liste toplayıcı koşuları sayılır; ilk aktarım sayılmaz."
          />
          <KpiCard label="Sonraki yenileme en erken" value={formatDateOrDash(q.nextAllowedAt)} />
          <KpiCard
            label="Yenileme"
            value={status.canStartRefresh ? "Başlatılabilir" : "Başlatılamaz"}
            tone={status.canStartRefresh ? "neutral" : "warning"}
            note={
              status.initialImport?.status !== "completed"
                ? "Önce ilk aktarım tamamlanmalı."
                : q.blockedBy
                  ? BLOCKED_TEXT[q.blockedBy]
                  : undefined
            }
          />
        </KpiGroup>

        {op && units ? (
          <>
            <h3>
              Etkin operasyon #{op.id}: {KIND_TEXT[op.kind]} ·{" "}
              {OPERATION_STATUS[op.status] ?? op.status}
            </h3>
            <KpiGroup label="İlerleme">
              <KpiCard label="Planlanan sitemap" value={formatCount(op.filesPlanned)} />
              <KpiCard label="İşlenen sitemap" value={formatCount(units.done)} />
              <KpiCard label="Bekleyen sitemap" value={formatCount(units.pending)} />
              <KpiCard
                label="Hatalı sitemap"
                value={formatCount(units.failed + units.blocked)}
                tone={units.failed + units.blocked > 0 ? "warning" : "neutral"}
                note={`Deneme hakkı biten: ${formatCount(units.failedFinal)}`}
              />
              <KpiCard
                label="Bu operasyonda yeni ürün"
                value={formatCount(units.itemsNew)}
                note={`Görülen adres: ${formatCount(units.itemsFound)}`}
              />
              <KpiCard label="Son checkpoint" value={formatDateOrDash(op.lastCheckpointAt)} />
              <KpiCard label="Son başarılı kontrol" value={formatDateOrDash(op.lastSuccessAt)} />
              <KpiCard
                label="İstek / bütçe"
                value={`${formatCount(op.requestsMade)} / ${formatCount(op.maxRequests)}`}
              />
              <KpiCard
                label="İndirilen (açılmış)"
                value={`${formatBytes(op.bytesDecoded)} / ${formatBytes(op.maxBytes)}`}
                note={`Bilinen aktarım: ${formatBytes(op.bytesTransferred)}`}
              />
              <KpiCard
                label="Çalışan istemci"
                value={op.clientActive ? "Var" : "Yok"}
                tone={op.clientActive ? "neutral" : "warning"}
                note={`Son sinyal: ${formatDateOrDash(op.leaseHeartbeatAt)}. İşlem kendiliğinden başka tarayıcıda sürmez.`}
              />
              {op.expiresAt ? (
                <KpiCard label="Kota penceresi bitişi" value={formatDateOrDash(op.expiresAt)} />
              ) : null}
              {status.resumeAllowedAt ? (
                <KpiCard
                  label="En erken sürdürme"
                  value={formatDateOrDash(status.resumeAllowedAt)}
                  tone="warning"
                />
              ) : null}
            </KpiGroup>
            {op.lastErrorCode ? (
              <p className={styles.muted}>
                Son hata: <code>{op.lastErrorCode}</code>
                {op.lastErrorDetail ? ` - ${op.lastErrorDetail}` : ""}
              </p>
            ) : null}
            {problems.length > 0 ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className="num">Sıra</th>
                      <th>Dosya</th>
                      <th>Durum</th>
                      <th className="num">Deneme</th>
                      <th>Hata</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problems.map((u) => (
                      <tr key={u.seq}>
                        <td className="num">{u.seq}</td>
                        <td>
                          <code>{new URL(u.fileUrl).pathname}</code>
                        </td>
                        <td>{u.status === "blocked" ? "Engel" : "Hatalı"}</td>
                        <td className="num">{u.attempts}</td>
                        <td>
                          {u.errorCode ?? "-"}
                          {u.errorDetail ? ` (${u.errorDetail})` : ""}
                        </td>
                        <td>{formatDateOrDash(u.claimedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}

        <DiscoveryClient
          source="hepsiburada"
          rules={{ urlHost: "hepsiburada.com", imageHost: "hepsiburada.net" }}
          active={
            op
              ? {
                  id: op.id,
                  kind: op.kind,
                  status: op.status,
                  clientActive: op.clientActive,
                  leaseClient: op.leaseClient,
                }
              : null
          }
          canStartInitial={status.canStartInitial}
          canStartRefresh={status.canStartRefresh}
        />
        <p className={styles.muted}>
          İstekler arası bekleme, günlük tavan ve bütçeler sunucuda zorlanır. 403, 429, doğrulama
          sayfası ya da beklenmeyen yapı görülürse operasyon durur ve en erken{" "}
          {p.blockedCooldownHours} saat sonra elle sürdürülebilir. Bir ürün yalnızca{" "}
          {p.removalMissedScans} ardışık TAM haftalık taramada görülmezse kaldırılmış sayılır; yarım
          tarama hiçbir ürünü etkilemez.
        </p>
      </Section>

      <Section id="gecmis-operasyon" title="Keşif operasyonları">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Operasyon</th>
                <th>Tür</th>
                <th>Durum</th>
                <th>Başlangıç</th>
                <th className="num">Dosya</th>
                <th className="num">İstek</th>
                <th>Veri</th>
                <th>Kaldırma</th>
              </tr>
            </thead>
            <tbody>
              {status.recent.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{KIND_TEXT[r.kind]}</td>
                  <td>{OPERATION_STATUS[r.status] ?? r.status}</td>
                  <td>{formatDateOrDash(r.createdAt)}</td>
                  <td className="num">{formatCount(r.filesPlanned)}</td>
                  <td className="num">{formatCount(r.requestsMade)}</td>
                  <td>{formatBytes(r.bytesDecoded)}</td>
                  <td>{REMOVAL_TEXT[r.removalState] ?? r.removalState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        id="toplayici"
        title="Liste toplayıcı (doğrulanmış fiyat)"
        description="Sorgu listesi senin verdiğin terimlerdir; kaynağın tüm kataloğuna erişim varsayılmaz. Bu koşular haftalık yenileme hakkını kullanır. 403, 429 ya da doğrulama sayfasında koşu durur."
      >
        <CollectorClient
          source="hepsiburada"
          canStart={q.canStart}
          openRun={
            status.openListingRun
              ? {
                  id: status.openListingRun.id,
                  requestsMade: status.openListingRun.requestsMade,
                  maxRequests: status.openListingRun.maxRequests,
                  expiresAt: status.openListingRun.expiresAt.toISOString(),
                  checkpoint: status.openListingRun.checkpoint,
                }
              : null
          }
        />
      </Section>

      <Section id="gecmis" title="Kota defteri (eski koşular dahil)">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Koşu</th>
                <th>Tür</th>
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
                  <td>
                    {r.options?.mode === "sitemap_refresh" ? "Sitemap yenileme" : "Liste toplayıcı"}
                  </td>
                  <td>{r.status}</td>
                  <td>{formatDateOrDash(r.reservedAt)}</td>
                  <td className="num">
                    {formatCount(
                      typeof r.summary?.requests === "number" ? r.summary.requests : r.requestsMade,
                    )}
                  </td>
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
