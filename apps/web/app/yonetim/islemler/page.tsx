import {
  addCost,
  type CostSummary,
  capabilitiesFor,
  emptyCostSummary,
  evaluatePipeline,
  getOperationsOverview,
  jobLabel,
  KNOWN_JOBS,
  operationsFindings,
  runOrphanCheck,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  ErrorNotice,
  FindingList,
  KeyValues,
  PageHeader,
  Section,
  StatusText,
  Tile,
} from "../admin-ui.tsx";
import {
  formatCost,
  formatCount,
  formatDateOrDash,
  formatDuration,
  formatUsage,
  hrefWith,
  PIPELINE_STAGE_INFO,
  pipelineReasonText,
  pipelineSourceLabel,
  pipelineStateLabel,
} from "../format.ts";

function monthLabel(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Sistem sağlığı (Faz 5, karar 0055). Her önemli durum bir `AdminFinding`'dir
 * (önem, kanıt zamanı, anlam, ne yapmalı, teşhis bağlantısı); altındaki
 * bölümler ayrıntıdır. Denetim, hata ve analitik burada değil. Çalıştır /
 * yeniden dene düğmesi YOK: işler kendi zamanlayıcılarından ve komut
 * satırından yürür.
 */
export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ yetim?: string }>;
}) {
  const { user, actor } = await requireCapability("operations.read");
  const { yetim } = await searchParams;
  const db = getDatabase();
  const [ops, orphans] = await Promise.all([
    getOperationsOverview(db, actor),
    yetim === "1" ? runOrphanCheck(db, actor) : Promise.resolve(null),
  ]);

  const costByOperation = new Map<string, CostSummary>();
  if (ops.cost.ok) {
    for (const row of ops.cost.value) {
      costByOperation.set(
        row.operation,
        addCost(costByOperation.get(row.operation) ?? emptyCostSummary(), row),
      );
    }
  }
  const pipeline = evaluatePipeline(ops.pipeline, ops.generatedAt);
  const findings = operationsFindings(ops);
  const open = findings.filter((f) => f.severity !== "healthy");
  const healthy = findings.filter((f) => f.severity === "healthy");
  const allowed = capabilitiesFor(user.role);

  return (
    <div className={styles.page}>
      <PageHeader title="Sistem sağlığı">
        <p className={styles.muted}>
          Veritabanından okunabilen işletim denetimleri. Her bulgu ne anlama geldiğini ve ne
          yapılacağını söyler; denetim çalışmazsa durum &quot;Bilinmiyor&quot; olur, sağlıklı
          sayılmaz.
        </p>
      </PageHeader>

      <Section id="durum" title="Durum">
        <FindingList
          findings={open}
          allowed={allowed}
          empty="Dikkat gerektiren bir şey yok; tüm denetimler sağlıklı."
        />
        {healthy.length > 0 ? (
          <details className={styles.healthyList}>
            <summary>{`Sağlıklı denetimler (${healthy.length})`}</summary>
            <FindingList findings={healthy} allowed={allowed} />
          </details>
        ) : null}
      </Section>

      <Section id="is-kosulari" title="İş koşuları">
        <p className={styles.muted}>
          Python boru hattı işleri ve zamanlanmış uçlar her koşuyu kaydeder (180 gün). Kaydı olmayan
          iş henüz kayıt tutan sürümle çalışmamıştır.{" "}
          <Link href="/yonetim/islemler/isler">Tüm koşular</Link>
        </p>
        {ops.jobRuns.ok ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">İş</th>
                  <th scope="col">Son koşu</th>
                  <th scope="col">Durum</th>
                  <th scope="col">Süre</th>
                  <th scope="col">Son başarılı</th>
                  <th scope="col">Nasıl çalışır</th>
                </tr>
              </thead>
              <tbody>
                {ops.jobRuns.value.jobs.map((job) => (
                  <tr key={job.job}>
                    <td>
                      <Link href={hrefWith("/yonetim/islemler/isler", { is: job.job })}>
                        {jobLabel(job.job)}
                      </Link>
                    </td>
                    <td>{job.lastRun ? formatDateOrDash(job.lastRun.startedAt) : "Kayıt yok"}</td>
                    <td>
                      {job.lastRun ? <StatusText status={job.lastRun.status} /> : "—"}
                      {job.failuresSinceGood > 1 ? (
                        <span className={styles.meta} style={{ display: "block" }}>
                          {`${formatCount(job.failuresSinceGood)} başarısız (son başarılıdan beri)`}
                        </span>
                      ) : null}
                    </td>
                    <td>{formatDuration(job.lastRun?.durationMs ?? null)}</td>
                    <td>{formatDateOrDash(job.lastGoodAt)}</td>
                    <td className={styles.mono}>{KNOWN_JOBS[job.job]?.how ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ErrorNotice>{ops.jobRuns.error}</ErrorNotice>
        )}
      </Section>

      <Section id="boru-hatti" title="Veri boru hattı">
        <p className={styles.muted}>
          Aşamalar elle (komut satırından) çalışır. İş koşusu kaydı varsa durum oradan okunur
          (&quot;son çalıştı&quot;); yoksa aşamanın ürettiği verinin en yeni zamanından (&quot;son
          kanıt&quot;). &quot;Geride olabilir&quot;: beslendiği aşama daha yeni çalıştı; kesin
          değildir.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Aşama</th>
                <th scope="col">Durum</th>
                <th scope="col">Son çalıştı / son kanıt</th>
                <th scope="col">Kanıt</th>
                <th scope="col">Çalıştırma</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.map((stage) => {
                const info = PIPELINE_STAGE_INFO[stage.stage];
                const tone =
                  stage.state === "warning" || stage.state === "unknown"
                    ? styles.statusBad
                    : stage.state === "behind"
                      ? styles.statusWarn
                      : undefined;
                return (
                  <tr key={stage.stage}>
                    <td>{info.label}</td>
                    <td>
                      <span className={tone}>{pipelineStateLabel(stage.state)}</span>
                      {stage.reasons.map((reason) => (
                        <span key={reason} className={styles.meta} style={{ display: "block" }}>
                          {pipelineReasonText(reason)}
                        </span>
                      ))}
                    </td>
                    <td>
                      {formatDateOrDash(stage.lastAt)}
                      {stage.lastAt ? (
                        <span className={styles.meta} style={{ display: "block" }}>
                          {pipelineSourceLabel(stage.source)}
                        </span>
                      ) : null}
                    </td>
                    <td className={styles.meta}>{info.evidence}</td>
                    <td className={styles.mono}>{info.command ?? "işçi (otomatik)"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="partition" title="Fiyat geçmişi partition'ları">
        {ops.partitions.ok ? (
          <KeyValues
            items={[
              [
                "Aylık aralık",
                ops.partitions.value.ranges.length > 0
                  ? `${monthLabel(ops.partitions.value.ranges[0]?.from ?? new Date())} → ${monthLabel(
                      new Date(
                        (ops.partitions.value.ranges.at(-1)?.to.getTime() ?? Date.now()) - 1,
                      ),
                    )} (${ops.partitions.value.ranges.length} ay)`
                  : "—",
              ],
              ["Bu aydan sonra hazır", `${Math.max(0, ops.partitions.value.monthsAhead)} ay`],
              ["Aralık boşluğu", String(ops.partitions.value.gaps.length)],
              ["Default partition", ops.partitions.value.hasDefault ? "Var" : "Yok"],
              ["Kapsanmayan satır", formatCount(ops.partitions.value.uncoveredRows)],
            ]}
          />
        ) : (
          <ErrorNotice>{ops.partitions.error}</ErrorNotice>
        )}
      </Section>

      <Section id="isler" title="Zamanlanmış uçların veri kanıtı">
        {ops.jobs.ok ? (
          <KeyValues
            items={[
              [
                "Keşfet slotu (gece cron'u)",
                ops.jobs.value.latestDiscoverySlot ?? "Hiç üretilmedi",
              ],
              ["Son alarm bildirimi (15 dk)", formatDateOrDash(ops.jobs.value.lastAlertNotifiedAt)],
              ["Aktif alarm", formatCount(ops.jobs.value.activeAlerts)],
              [
                "Son veri toplama koşusu",
                <Link key="ingest" href="/yonetim/ingest">
                  {formatDateOrDash(ops.jobs.value.lastIngestStartedAt)}
                </Link>,
              ],
              [
                "Fiyat istatistiği (elle çalışan iş)",
                formatDateOrDash(ops.jobs.value.lastPriceStatsAt),
              ],
              [
                "Bekleyen eşleştirme",
                `${formatCount(ops.jobs.value.pendingMatches)} (eşik ${ops.jobs.value.matchQueueThreshold})`,
              ],
              [
                "Link çözümleme kuyruğu (Redis)",
                ops.linkQueue.ok ? formatCount(ops.linkQueue.value) : "Redis'e ulaşılamadı",
              ],
            ]}
          />
        ) : (
          <ErrorNotice>{ops.jobs.error}</ErrorNotice>
        )}
      </Section>

      <Section id="kvkk" title="Saklama ve temizlik (KVKK)">
        {ops.compliance.ok ? (
          <KeyValues
            items={[
              [
                "Depoda kalan ham görsel (beklenen 0: ham görsel saklanmaz)",
                formatCount(ops.compliance.value.imagePurgeOverdue),
              ],
              [
                "Süresi geçmiş giriş bağlantısı (1 günden eski)",
                formatCount(ops.compliance.value.expiredLoginTokens),
              ],
              [
                "Süresi geçmiş telefon kodu (1 günden eski)",
                formatCount(ops.compliance.value.expiredPhoneCodes),
              ],
            ]}
          />
        ) : (
          <ErrorNotice>{ops.compliance.error}</ErrorNotice>
        )}
      </Section>

      <Section id="maliyet" title="Model maliyeti (14 gün, api_usage)">
        {ops.cost.ok ? (
          <>
            <div className={styles.tiles}>
              {[...costByOperation.entries()].map(([operation, entry]) => {
                const cost = formatCost(entry);
                return (
                  <Tile
                    key={operation}
                    label={operation}
                    value={cost.value}
                    note={[cost.note, formatUsage(entry)].filter(Boolean).join(" · ")}
                    warning={cost.note !== null}
                  />
                );
              })}
            </div>
            {ops.cost.value.length === 0 ? (
              <p className={styles.muted}>Son 14 günde model çağrısı yok.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Gün</th>
                      <th scope="col">İşlem</th>
                      <th scope="col" className={styles.num}>
                        Çağrı
                      </th>
                      <th scope="col" className={styles.num}>
                        Önbellekten
                      </th>
                      <th scope="col" className={styles.num}>
                        Birim
                      </th>
                      <th scope="col" className={styles.num}>
                        Maliyet
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ops.cost.value.map((row) => (
                      <tr key={`${row.day}-${row.operation}`}>
                        <td>{row.day}</td>
                        <td>{row.operation}</td>
                        <td className={styles.num}>{formatCount(row.calls)}</td>
                        <td className={styles.num}>{formatCount(row.cacheHits)}</td>
                        <td className={styles.num}>{formatCount(row.units)}</td>
                        <td className={styles.num}>{formatCost(row).value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <ErrorNotice>{ops.cost.error}</ErrorNotice>
        )}
      </Section>

      <Section id="yetim" title="Polimorfik yetim denetimi">
        <p className={styles.muted}>
          `pnpm db:orphans` ile aynı sorgu. Tam tablo taraması olduğu için yalnızca istenince
          çalışır (en fazla 10 sn).
        </p>
        {orphans === null ? (
          <p>
            <Link href="/yonetim/islemler?yetim=1#yetim">Denetimi çalıştır</Link>
          </p>
        ) : orphans.ok ? (
          orphans.value.length === 0 ? (
            <p>Yetim satır yok — beklenen durum.</p>
          ) : (
            <ErrorNotice>
              {`Kritik: ${orphans.value
                .map((g) => `${g.tablo}/${g.targetType} (${g.sebep}) ${g.adet}`)
                .join(", ")}. Runbook: docs/ops.md.`}
            </ErrorNotice>
          )
        ) : (
          <ErrorNotice>{orphans.error}</ErrorNotice>
        )}
      </Section>

      <p className={styles.muted}>{`Oluşturuldu: ${formatDateOrDash(ops.generatedAt)}`}</p>
    </div>
  );
}
