import {
  addCost,
  type CostSummary,
  emptyCostSummary,
  evaluatePipeline,
  getOperationsOverview,
  PARTITION_MONTHS_AHEAD,
  runOrphanCheck,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { ErrorNotice, KeyValues, PageHeader, Section, Tile } from "../admin-ui.tsx";
import {
  formatCost,
  formatCount,
  formatDateOrDash,
  formatUsage,
  PIPELINE_STAGE_INFO,
  pipelineReasonLabel,
  pipelineStateLabel,
} from "../format.ts";

function monthLabel(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * İşletim sağlığı (Faz 5). docs/ops.md §İzleme eşiklerinin veritabanından
 * okunabilenleri. Denetim, hata ve analitik burada değil. Çalıştır/yeniden
 * dene düğmesi YOK: işler kendi zamanlayıcılarından ve komut satırından yürür.
 */
export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ yetim?: string }>;
}) {
  const { actor } = await requireCapability("operations.read");
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

  return (
    <div className={styles.page}>
      <PageHeader title="İşletim">
        <p className={styles.muted}>
          Veritabanından okunabilen sağlık sinyalleri. İş geçmişi tablosu olmadığı için işlerin
          durumu ürettikleri verinin tazeliğinden okunur ("son kanıt").
        </p>
      </PageHeader>

      <Section id="partition" title="Fiyat geçmişi partition'ları">
        {ops.partitions.ok ? (
          <>
            {ops.partitions.value.uncoveredRows > 0 ? (
              <ErrorNotice>
                {`KRİTİK: ${formatCount(ops.partitions.value.uncoveredRows)} fiyat noktası hiçbir aylık partition'a girmiyor (price_point_default dolu). Runbook: docs/ops.md.`}
              </ErrorNotice>
            ) : null}
            {ops.partitions.value.monthsAhead < PARTITION_MONTHS_AHEAD ? (
              <ErrorNotice>
                {`Yalnızca ${Math.max(0, ops.partitions.value.monthsAhead)} ay ileri partition hazır; en az ${PARTITION_MONTHS_AHEAD} olmalı. Çalıştır: pnpm db:partitions`}
              </ErrorNotice>
            ) : null}
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
          </>
        ) : (
          <ErrorNotice>{ops.partitions.error}</ErrorNotice>
        )}
      </Section>

      <Section id="boru-hatti" title="Veri boru hattı (son kanıt)">
        <p className={styles.muted}>
          Aşamalar elle (komut satırından) çalışır; iş geçmişi tablosu yoktur. Durum, her aşamanın
          ürettiği verinin en yeni zamanından okunur. &quot;Geride olabilir&quot;: beslendiği
          aşamanın kanıtı daha yeni; yeni veri yoksa aşama iz bırakmadığı için kesin değildir.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Aşama</th>
                <th scope="col">Durum</th>
                <th scope="col">Son kanıt</th>
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
                          {pipelineReasonLabel(reason)}
                        </span>
                      ))}
                    </td>
                    <td>{formatDateOrDash(stage.lastAt)}</td>
                    <td className={styles.meta}>{info.evidence}</td>
                    <td className={styles.mono}>{info.command ?? "işçi (otomatik)"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="isler" title="İşlerin son kanıtı">
        {ops.jobs.ok ? (
          <>
            {ops.jobs.value.stuckIngestRuns > 0 ? (
              <ErrorNotice>
                {`${ops.jobs.value.stuckIngestRuns} veri toplama koşusu 2 saattir "sürüyor" durumunda.`}
              </ErrorNotice>
            ) : null}
            <KeyValues
              items={[
                [
                  "Keşfet slotu (gece cron'u)",
                  ops.jobs.value.latestDiscoverySlot ?? "Hiç üretilmedi",
                ],
                [
                  "Son alarm bildirimi (15 dk)",
                  formatDateOrDash(ops.jobs.value.lastAlertNotifiedAt),
                ],
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
          </>
        ) : (
          <ErrorNotice>{ops.jobs.error}</ErrorNotice>
        )}
      </Section>

      <Section id="kvkk" title="Saklama ve temizlik (KVKK)">
        {ops.compliance.ok ? (
          <>
            {ops.compliance.value.imagePurgeOverdue > 0 ? (
              <ErrorNotice>
                {`${formatCount(ops.compliance.value.imagePurgeOverdue)} yüklenen görselin ham dosyası depoda ve saklama süresi geçmiş. Ham görsel saklanmamalıydı; kodu ve depoyu inceleyin.`}
              </ErrorNotice>
            ) : null}
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
          </>
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
              {`KRİTİK: ${orphans.value
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
