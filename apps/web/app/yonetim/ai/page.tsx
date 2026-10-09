import {
  AI_OPERATIONS,
  type AiDailyRow,
  type AiUsageRow,
  ANALYTICS_WINDOWS,
  addCost,
  emptyCostSummary,
  getAiOperationsOverview,
  hasCapability,
  type ProviderCap,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  KeyValues,
  KpiCard,
  Notice,
  PageHeader,
  Panel,
  Tabs,
} from "../admin-ui.tsx";
import {
  chargeStateLabel,
  chatKindLabel,
  formatCost,
  formatCount,
  formatDateTime,
  formatPercent,
  hrefWith,
  interpretationStatusLabel,
  refundReasonLabel,
  searchOperationLabel,
} from "../format.ts";

const PATH = "/yonetim/ai";

function operationLabel(operation: string): string {
  return AI_OPERATIONS[operation]?.label ?? operation;
}

function windowLabel(days: number): string {
  return days === 1 ? "Son 24 saat" : `Son ${days} gün`;
}

/**
 * AI operasyonları (karar 0085, `ai.read`, yalnızca yönetici). Yalnızca
 * toplamlar: kullanıcı başına AI maliyeti ve sohbet içeriği gösterilmez.
 * Maliyet tahminidir (karar 0082); gecikme ve hata oranı ölçülmüyor.
 */
export default async function AiOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ gun?: string }>;
}) {
  const { user, actor } = await requireCapability("ai.read");
  const params = await searchParams;
  const overview = await getAiOperationsOverview(getDatabase(), actor, { days: params.gun });
  const totals = overview.usage.reduce(addCost, emptyCostSummary());
  const cost = formatCost(totals);
  const paid = totals.calls - totals.cacheHits;

  return (
    <div className={styles.page}>
      <PageHeader
        title="AI operasyonları"
        description={`Model çağrıları, token, tahmini maliyet, kota ve sağlayıcı tavanı. ${formatDateTime(overview.generatedAt)} itibarıyla; yalnızca toplamlar.`}
        actions={
          <Tabs
            label="Zaman aralığı"
            items={ANALYTICS_WINDOWS.map((days) => ({
              href: hrefWith(PATH, { gun: days }),
              label: windowLabel(days),
              active: days === overview.days,
            }))}
          />
        }
      />

      <div className={styles.kpiGrid}>
        <KpiCard
          label={`Model çağrısı (${windowLabel(overview.days).toLowerCase()})`}
          value={formatCount(totals.calls)}
          note={`${formatCount(totals.cacheHits)} önbellekten · ${formatCount(paid)} sağlayıcıya`}
          basis="count"
        />
        <KpiCard
          label="Token (toplam)"
          value={formatCount(totals.units)}
          note="Girdi/çıktı ayrımı saklanmıyor"
          basis="count"
        />
        <KpiCard
          label="Tahmini maliyet"
          value={cost.value}
          note={cost.note}
          tone={cost.note ? "warning" : "neutral"}
          basis="estimate"
        />
        <KpiCard
          label="Önbellek isabeti"
          value={formatPercent(totals.cacheHits, totals.calls)}
          note="Önbellekten dönen çağrı ücretsizdir"
          basis="count"
        />
        <KpiCard
          label="Gecikme (p50 / p95)"
          value="—"
          note="Saklanmıyor; yalnızca isteğe bağlı sunucu günlüğü (Faz E)"
          basis="unmeasured"
        />
        <KpiCard
          label="Hata oranı"
          value="—"
          note="Başarısız deneme ayrı işaretlenmiyor (Faz E)"
          basis="unmeasured"
        />
      </div>

      <Panel
        id="islem-model"
        title="İşlem ve modele göre"
        description="Tutarlar çağrı anındaki liste fiyatı × kur tahminidir (karar 0082); fatura değildir."
        flush={overview.usage.length > 0}
        actions={<DataBasis kind="estimate" />}
      >
        <DataTable<AiUsageRow>
          rows={overview.usage}
          rowKey={(row) => `${row.operation}|${row.modelVersion ?? "-"}`}
          stack
          empty={<EmptyPanel title="Bu aralıkta model çağrısı yok" />}
          columns={[
            { key: "op", header: "İşlem", cell: (row) => operationLabel(row.operation) },
            {
              key: "model",
              header: "Model",
              cell: (row) => <span className={styles.mono}>{row.modelVersion ?? "—"}</span>,
            },
            { key: "calls", header: "Çağrı", numeric: true, cell: (row) => formatCount(row.calls) },
            {
              key: "hits",
              header: "Önbellek",
              numeric: true,
              cell: (row) => formatCount(row.cacheHits),
            },
            { key: "units", header: "Token", numeric: true, cell: (row) => formatCount(row.units) },
            {
              key: "cost",
              header: "Tahmini maliyet",
              numeric: true,
              cell: (row) => formatCost(row).value,
            },
            {
              key: "unpriced",
              header: "Fiyatlanmamış",
              numeric: true,
              cell: (row) => formatCount(row.unpricedCalls),
            },
          ]}
        />
      </Panel>

      <div className={styles.panelGrid}>
        <Panel
          id="tavan"
          title="Sağlayıcı günlük tavanı (bugün)"
          description="Koddaki sabit tavan ve bugünkü (İstanbul günü) gerçek deneme sayısı."
          flush
        >
          <DataTable<ProviderCap>
            rows={overview.caps}
            rowKey={(row) => row.operation}
            columns={[
              { key: "op", header: "İşlem", cell: (row) => operationLabel(row.operation) },
              {
                key: "today",
                header: "Bugün",
                numeric: true,
                cell: (row) => formatCount(row.callsToday),
              },
              { key: "cap", header: "Tavan", numeric: true, cell: (row) => formatCount(row.cap) },
              {
                key: "fill",
                header: "Doluluk",
                numeric: true,
                cell: (row) => formatPercent(row.callsToday, row.cap),
              },
            ]}
          />
        </Panel>

        <Panel
          id="kota"
          title="Arama hakkı (kota)"
          description="Fotoğraf/link araması hakkı PostgreSQL'de; sohbet ve anlık yorum kotası Redis'te ve reddedilen istekler saklanmıyor."
        >
          <KeyValues
            items={[
              ["Bugün hak kullanan hesap", formatCount(overview.searchRights.usersToday)],
              [
                `Günlük limiti (${overview.searchRights.dailyLimit}) dolan hesap`,
                formatCount(overview.searchRights.usersAtDailyLimitToday),
              ],
              ["Sohbet / anlık yorum kota reddi", <DataBasis key="r" kind="unmeasured" />],
            ]}
          />
          <DataTable
            rows={overview.searchRights.charges}
            rowKey={(row) => `${row.operation}|${row.state}`}
            empty={<p className={styles.muted}>Bu aralıkta hak harcaması yok.</p>}
            columns={[
              {
                key: "op",
                header: "İşlem",
                cell: (row) => searchOperationLabel(row.operation),
              },
              { key: "state", header: "Durum", cell: (row) => chargeStateLabel(row.state) },
              { key: "n", header: "Sayı", numeric: true, cell: (row) => formatCount(row.count) },
            ]}
          />
          {overview.searchRights.refundReasons.length > 0 ? (
            <KeyValues
              items={overview.searchRights.refundReasons.map((row) => [
                `İade: ${refundReasonLabel(row.reason)}`,
                formatCount(row.count),
              ])}
            />
          ) : null}
        </Panel>
      </div>

      <div className={styles.panelGrid}>
        <Panel
          id="yorum"
          title="Sorgu yorumu sonuçları"
          description="Gemini'nin sorgu yorumu (toplu + anlık) saklanan sonuç dağılımı."
          footer={<Link href="/yonetim/arama/tani">Arama tanısı</Link>}
        >
          {overview.interpretation.length === 0 ? (
            <p className={styles.muted}>Bu aralıkta yorum yok.</p>
          ) : (
            <KeyValues
              items={overview.interpretation.map((row) => [
                interpretationStatusLabel(row.status),
                formatCount(row.count),
              ])}
            />
          )}
        </Panel>

        <Panel
          id="sohbet"
          title="Sohbet (yalnızca sayılar)"
          description="Mesaj içeriği, başlık ve kullanıcı bu ekranda yoktur (karar 0074, 0079)."
          footer={
            hasCapability(user.role, "feedback.chat.read") ? (
              <Link href="/yonetim/ai-geri-bildirim">AI geri bildirimleri</Link>
            ) : null
          }
        >
          <KeyValues
            items={[
              ["Başlayan konuşma", formatCount(overview.chat.conversationsStarted)],
              ["Mesajı olan konuşma", formatCount(overview.chat.activeConversations)],
              ["Kullanıcı mesajı", formatCount(overview.chat.userMessages)],
              ...overview.chat.assistantByKind.map(
                (row) =>
                  [`Yanıt: ${chatKindLabel(row.kind)}`, formatCount(row.count)] as [string, string],
              ),
              ["Tur sonucu (hata, netleştirme oranı)", <DataBasis key="t" kind="unmeasured" />],
            ]}
          />
        </Panel>
      </div>

      <Panel
        id="gunluk"
        title="Günlük kullanım"
        description="İstanbul gününe göre; işlem başına."
        flush={overview.daily.length > 0}
      >
        <DataTable<AiDailyRow>
          rows={overview.daily}
          rowKey={(row) => `${row.day}|${row.operation}`}
          stack
          empty={<EmptyPanel title="Bu aralıkta model çağrısı yok" />}
          columns={[
            { key: "day", header: "Gün", cell: (row) => row.day },
            { key: "op", header: "İşlem", cell: (row) => operationLabel(row.operation) },
            { key: "calls", header: "Çağrı", numeric: true, cell: (row) => formatCount(row.calls) },
            { key: "units", header: "Token", numeric: true, cell: (row) => formatCount(row.units) },
            {
              key: "cost",
              header: "Tahmini maliyet",
              numeric: true,
              cell: (row) => formatCost(row).value,
            },
          ]}
        />
      </Panel>

      <Notice title="Ölçülmeyenler">
        Gecikme, çağrı sonucu (başarılı/hata), girdi/çıktı token ayrımı ve Redis kota reddi
        saklanmıyor; gerçek fatura sağlayıcının dökümündedir. Bunlar telemetri kararı ister (Faz E).
      </Notice>
    </div>
  );
}
