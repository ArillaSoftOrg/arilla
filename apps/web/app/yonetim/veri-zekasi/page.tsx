import {
  type BuildDetail,
  type CollectionAuditRow,
  getBuildDetail,
  getCollectionAudit,
  getDataIntelligenceOverview,
  getEventVolumes,
  hasCapability,
  listPendingLabels,
  policyFromEnv,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Button } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataTable,
  EmptyPanel,
  KeyValues,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
} from "../admin-ui.tsx";
import { formatCount, formatDateTime } from "../format.ts";
import {
  buildDatasetAction,
  cancelExportAction,
  drawSampleAction,
  labelAction,
  requestExportAction,
} from "./actions.ts";

const PATH = "/yonetim/veri-zekasi";

const COLLECTION_LABEL = {
  collected: "Toplanıyor",
  partial: "Kısmi",
  not_collected: "Toplanmıyor",
} as const;
const LICENSING_LABEL = {
  unverified: "Hukuki dayanak doğrulanmadı",
  barred: "Ticari çıktıya kapalı",
  not_applicable: "Veri yok",
} as const;
const STATUS_LABEL: Record<string, string> = {
  ready: "Hazır",
  insufficient_data: "Veri yetersiz",
  blocked: "Kapalı",
  failed: "Başarısız",
  requested: "İstendi",
  completed: "Tamamlandı",
  cancelled: "İptal",
};
const METRIC_TONE = {
  PASS: "success",
  WARN: "warning",
  FAIL: "critical",
  NOT_MEASURED: "neutral",
} as const;
const REASON_LABEL: Record<string, string> = {
  build_disabled: "Üretim bayrağı kapalı (hukuki onay bekliyor)",
  no_event_source: "Kaynak olay toplanmıyor",
  no_events_in_period: "Dönemde olay yok",
  no_eligible_events: "Uygun olay yok",
  all_cells_below_k: "Tüm hücreler k-eşiğinin altında",
  source_read_failed: "Kaynak okunamadı",
};

function messageOf(
  code: string | undefined,
): { tone: "success" | "warning" | "error"; text: string } | null {
  if (!code) return null;
  if (code === "stale")
    return {
      tone: "warning",
      text: "Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski).",
    };
  if (code === "yetki") return { tone: "error", text: "Bu işlem için yetkin yok." };
  if (code.startsWith("girdi")) return { tone: "error", text: `Geçersiz girdi. ${code.slice(6)}` };
  if (code.startsWith("red:"))
    return { tone: "error", text: `Dışa aktarım reddedildi (${code.slice(4)}).` };
  if (code.startsWith("uretim:"))
    return {
      tone: code === "uretim:ready" ? "success" : "warning",
      text: `Üretim sonucu: ${STATUS_LABEL[code.slice(7)] ?? code.slice(7)}.`,
    };
  if (code.startsWith("export:"))
    return {
      tone: code === "export:completed" ? "success" : "warning",
      text: `Dışa aktarım: ${code.slice(7)}.`,
    };
  return { tone: "success", text: "İşlem tamamlandı." };
}

function CollectionTable({ rows }: { rows: CollectionAuditRow[] }) {
  return (
    <DataTable
      stack
      rows={rows}
      rowKey={(r) => r.key}
      columns={[
        {
          key: "label",
          header: "Olay",
          cell: (r) => (
            <>
              <strong>{r.label}</strong>
              <br />
              <span className={styles.muted}>{r.events}</span>
            </>
          ),
        },
        {
          key: "status",
          header: "Gerçek durum",
          cell: (r) => (
            <StatusBadge
              tone={
                r.status === "collected"
                  ? "success"
                  : r.status === "partial"
                    ? "warning"
                    : "neutral"
              }
            >
              {COLLECTION_LABEL[r.status]}
            </StatusBadge>
          ),
        },
        {
          key: "legal",
          header: "Ticari lisans dayanağı",
          cell: (r) => (
            <>
              <StatusBadge tone="warning">{LICENSING_LABEL[r.licensingStatus]}</StatusBadge>
              <br />
              <span className={styles.muted}>{r.licensingNote}</span>
            </>
          ),
        },
        {
          key: "live",
          header: "Canlı sayım",
          cell: (r) => (
            <ul>
              {r.live.map((m) => (
                <li key={m.label}>
                  {m.label}:{" "}
                  {m.value === null
                    ? "Ölçülmedi"
                    : m.value <= 1 && m.label.includes("payı")
                      ? `%${Math.round(m.value * 100)}`
                      : formatCount(m.value)}
                  {m.note ? ` (${m.note})` : ""}
                </li>
              ))}
              {r.lastAt ? <li>Son olay: {formatDateTime(r.lastAt)}</li> : null}
            </ul>
          ),
        },
        {
          key: "gaps",
          header: "Kayıt noktası ve eksikler",
          cell: (r) => (
            <>
              <span className={styles.muted}>{r.recordPoint}</span>
              <ul>
                {r.missingFields.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <span className={styles.muted}>Tekrar riski: {r.duplicateRisk}</span>
            </>
          ),
        },
      ]}
    />
  );
}

function BuildDetailPanel({
  detail,
  canBuild,
  canExport,
  pending,
}: {
  detail: BuildDetail;
  canBuild: boolean;
  canExport: boolean;
  pending: Awaited<ReturnType<typeof listPendingLabels>>;
}) {
  const metrics = (detail.qualityReport.metrics ?? []) as {
    key: string;
    dimension: string;
    status: keyof typeof METRIC_TONE;
    detail: string;
  }[];
  const limits = (detail.qualityReport.knownLimitations ?? []) as string[];
  const checks = (detail.anonymity.checks ?? []) as {
    id: string;
    passed: boolean;
    detail: string;
  }[];
  return (
    <Panel
      id="detail"
      title={`Sürüm ${detail.version}`}
      description={`${detail.datasetKey} · ${detail.period} · ${formatCount(detail.rowCount)} satır`}
    >
      <KeyValues
        items={[
          ["Durum", STATUS_LABEL[detail.status] ?? detail.status],
          [
            "Neden",
            detail.statusReason ? (REASON_LABEL[detail.statusReason] ?? detail.statusReason) : "—",
          ],
          ["İçerik SHA-256", detail.contentSha256 ?? "—"],
          [
            "Teknik anonimlik kontrolleri",
            detail.anonymityOk
              ? "Geçti (hukuki garanti değildir)"
              : "Geçmedi — dışa aktarıma kapalı",
          ],
        ]}
      />
      {checks.length > 0 ? (
        <DataTable
          caption="Anonimlik kontrolleri"
          rows={checks}
          rowKey={(c) => c.id}
          columns={[
            { key: "id", header: "Kontrol", cell: (c) => c.id },
            {
              key: "ok",
              header: "Sonuç",
              cell: (c) => (
                <StatusBadge tone={c.passed ? "success" : "critical"}>
                  {c.passed ? "Geçti" : "Geçmedi"}
                </StatusBadge>
              ),
            },
            { key: "d", header: "Ayrıntı", cell: (c) => c.detail },
          ]}
        />
      ) : null}
      {metrics.length > 0 ? (
        <DataTable
          caption="Kalite raporu"
          stack
          rows={metrics}
          rowKey={(m) => m.key}
          columns={[
            { key: "dim", header: "Boyut", cell: (m) => m.dimension },
            { key: "key", header: "Metrik", cell: (m) => m.key },
            {
              key: "st",
              header: "Durum",
              cell: (m) => (
                <StatusBadge tone={METRIC_TONE[m.status] ?? "neutral"}>
                  {m.status === "NOT_MEASURED" ? "Ölçülmedi" : m.status}
                </StatusBadge>
              ),
            },
            { key: "d", header: "Ayrıntı", cell: (m) => m.detail },
          ]}
        />
      ) : null}
      {limits.length > 0 ? (
        <Notice tone="info" title="Bilinen sınırlamalar">
          <ul>
            {limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {detail.preview.length > 0 ? (
        <DataTable
          caption="Önizleme (ilk 50 satır)"
          rows={detail.preview}
          rowKey={(r) => JSON.stringify(r)}
          columns={detail.columns.map((c) => ({
            key: c,
            header: c,
            cell: (r: Record<string, string | number>) => String(r[c]),
          }))}
        />
      ) : null}
      {canBuild && detail.status === "ready" ? (
        <form action={drawSampleAction} className={styles.inlineForm}>
          <input type="hidden" name="buildId" value={detail.id} />
          <label>
            Doğruluk örneği boyutu{" "}
            <input type="number" name="size" min={1} max={200} defaultValue={50} />
          </label>
          <Button type="submit">Temsilî örnek çek</Button>
        </form>
      ) : null}
      {pending.length > 0 ? (
        <DataTable
          caption="Etiket bekleyen örnekler (atanan değer doğru mu?)"
          rows={pending}
          rowKey={(p) => p.id}
          columns={[
            { key: "t", header: "Ürün", cell: (p) => p.productTitle },
            { key: "f", header: "Alan", cell: (p) => (p.field === "brand" ? "marka" : "kategori") },
            { key: "v", header: "Atanan", cell: (p) => p.assignedValue },
            {
              key: "a",
              header: "Karar",
              cell: (p) => (
                <form action={labelAction} className={styles.inlineForm}>
                  <input type="hidden" name="labelId" value={p.id} />
                  <input type="hidden" name="buildId" value={detail.id} />
                  <Button type="submit" name="verdict" value="correct">
                    Doğru
                  </Button>
                  <Button type="submit" name="verdict" value="incorrect">
                    Yanlış
                  </Button>
                  <Button type="submit" name="verdict" value="unsure">
                    Emin değilim
                  </Button>
                </form>
              ),
            },
          ]}
        />
      ) : null}
      {canExport ? (
        <form action={requestExportAction}>
          <input type="hidden" name="buildId" value={detail.id} />
          <Button type="submit" variant="primary" disabled={!detail.exportEligibleTechnically}>
            Dahili dışa aktarım iste
          </Button>
        </form>
      ) : null}
    </Panel>
  );
}

/**
 * Veri zekâsı (karar 0102, `data.read`, yalnızca yönetici). Yalnızca toplamlar ve
 * toplulaştırılmış veri seti sürümleri; kişi, oturum, sorgu metni yok. Üretim ve
 * dışa aktarım hukuki bayraklar kapalıyken devre dışıdır.
 */
export default async function DataIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ mesaj?: string; surum?: string }>;
}) {
  const { actor } = await requireCapability("data.read");
  const params = await searchParams;
  const db = getDatabase();
  const policy = policyFromEnv();
  const canBuild = hasCapability(actor.role, "data.build");
  const canExport = hasCapability(actor.role, "data.export");
  const buildId = /^\d{1,9}$/.test(params.surum ?? "") ? Number(params.surum) : null;
  const [overview, audit, volumes, detail] = await Promise.all([
    getDataIntelligenceOverview(db, actor, policy),
    getCollectionAudit(db, actor),
    getEventVolumes(db, actor, 14),
    buildId ? getBuildDetail(db, actor, buildId) : Promise.resolve(null),
  ]);
  const pending = detail ? await listPendingLabels(db, actor, detail.id, 10) : [];
  const message = messageOf(params.mesaj);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Veri zekâsı"
        description={`Toplulaştırılmış, anonimleştirilmiş eğilim veri setleri (dahili). ${formatDateTime(overview.generatedAt)} itibarıyla.`}
      />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Notice tone="warning" title="Hukuki durum">
        Ticari lisanslama için hukuki dayanak <strong>doğrulanmadı</strong>. Üretim:{" "}
        {policy.buildEnabled ? "açık" : "kapalı"} · Dışa aktarım:{" "}
        {policy.exportEnabled ? "açık" : "kapalı"} · Onaylı kaynak:{" "}
        {overview.policy.clearedSources.join(", ") || "yok"}. Teknik anonimlik kontrolleri riski
        azaltır, hukuki anonimlik garantisi vermez.
      </Notice>

      <Panel id="datasets" title="Üretilebilir veri setleri" flush>
        <DataTable
          stack
          rows={overview.datasets}
          rowKey={(d) => d.key}
          columns={[
            { key: "t", header: "Veri seti", cell: (d) => d.title },
            {
              key: "p",
              header: "Üretilebilir",
              cell: (d) =>
                d.producible ? (
                  <StatusBadge tone="success">Evet</StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">Hayır</StatusBadge>
                ),
            },
            {
              key: "l",
              header: "Son sürüm",
              cell: (d) =>
                d.latest ? (
                  <Link href={`${PATH}?surum=${d.latest.id}`}>
                    {d.latest.version} · {STATUS_LABEL[d.latest.status]}
                  </Link>
                ) : (
                  (d.notProducibleReason ?? "Henüz üretilmedi")
                ),
            },
            {
              key: "a",
              header: "Üret",
              cell: (d) =>
                canBuild && d.producible ? (
                  <form action={buildDatasetAction} className={styles.inlineForm}>
                    <input type="hidden" name="dataset" value={d.key} />
                    <select name="weeks" defaultValue="4" aria-label="Dönem">
                      <option value="1">Son 1 hafta</option>
                      <option value="4">Son 4 hafta</option>
                      <option value="8">Son 8 hafta</option>
                      <option value="13">Son 13 hafta</option>
                    </select>
                    <Button type="submit">Üret</Button>
                  </form>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      </Panel>

      {detail ? (
        <BuildDetailPanel
          detail={detail}
          canBuild={canBuild}
          canExport={canExport}
          pending={pending}
        />
      ) : null}

      <Panel id="history" title="Veri seti geçmişi" flush>
        <DataTable
          stack
          rows={overview.history}
          rowKey={(h) => h.id}
          empty={<EmptyPanel title="Henüz sürüm yok" />}
          columns={[
            {
              key: "v",
              header: "Sürüm",
              cell: (h) => <Link href={`${PATH}?surum=${h.id}`}>{h.version}</Link>,
            },
            { key: "k", header: "Veri seti", cell: (h) => h.datasetKey },
            { key: "d", header: "Dönem", cell: (h) => h.period },
            {
              key: "s",
              header: "Durum",
              cell: (h) => (
                <>
                  {STATUS_LABEL[h.status]}
                  {h.statusReason ? ` — ${REASON_LABEL[h.statusReason] ?? h.statusReason}` : ""}
                </>
              ),
            },
            { key: "n", header: "Satır", numeric: true, cell: (h) => formatCount(h.rowCount) },
            { key: "c", header: "Tarih", cell: (h) => formatDateTime(h.createdAt) },
          ]}
        />
      </Panel>

      <Panel
        id="exports"
        title="Dahili dışa aktarımlar"
        description="Müşteriye açık API ya da otomatik dış aktarım yoktur."
        flush
      >
        <DataTable
          stack
          rows={overview.exports}
          rowKey={(e) => e.id}
          empty={<EmptyPanel title="Henüz dışa aktarım yok" />}
          columns={[
            { key: "i", header: "No", numeric: true, cell: (e) => e.id },
            {
              key: "b",
              header: "Sürüm",
              cell: (e) => <Link href={`${PATH}?surum=${e.buildId}`}>#{e.buildId}</Link>,
            },
            {
              key: "s",
              header: "Durum",
              cell: (e) => (
                <>
                  {STATUS_LABEL[e.status]}
                  {e.errorClass ? ` (${e.errorClass})` : ""}
                </>
              ),
            },
            { key: "t", header: "Tarih", cell: (e) => formatDateTime(e.createdAt) },
            {
              key: "f",
              header: "Dosyalar",
              cell: (e) =>
                e.status === "completed" && canExport ? (
                  <>
                    {[
                      "data.csv",
                      "metadata.json",
                      "data_dictionary.json",
                      "quality_report.json",
                      "SHA256SUMS",
                    ].map((f) => (
                      <a key={f} href={`${PATH}/indir/${e.id}/${f}`} className={styles.muted}>
                        {f}{" "}
                      </a>
                    ))}
                  </>
                ) : e.status === "requested" && canExport ? (
                  <form action={cancelExportAction}>
                    <input type="hidden" name="exportId" value={e.id} />
                    <Button type="submit">İptal</Button>
                  </form>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      </Panel>

      <Panel id="volumes" title="Olay hacmi (son 14 gün, rızalı olaylar)" flush>
        <DataTable
          stack
          rows={volumes}
          rowKey={(v) => v.day}
          empty={<EmptyPanel title="Son 14 günde rızalı olay yok" />}
          columns={[
            { key: "d", header: "Gün", cell: (v) => v.day },
            {
              key: "pv",
              header: "product_viewed",
              numeric: true,
              cell: (v) => formatCount(v.product_viewed),
            },
            {
              key: "me",
              header: "merchant_exit",
              numeric: true,
              cell: (v) => formatCount(v.merchant_exit),
            },
            {
              key: "ss",
              header: "search_submitted",
              numeric: true,
              cell: (v) => formatCount(v.search_submitted),
            },
          ]}
        />
      </Panel>

      <Panel
        id="collection"
        title="Veri toplama denetimi"
        description="Gerçekte toplanan ile toplanmayan ayrı gösterilir; toplanmayan olay toplanıyormuş gibi sunulmaz."
        flush
      >
        <CollectionTable rows={audit} />
      </Panel>
    </div>
  );
}
