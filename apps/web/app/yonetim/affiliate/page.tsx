import { type AffiliateMerchantRow, ANALYTICS_WINDOWS, getAffiliateOverview } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  FilterBar,
  FilterField,
  KeyValues,
  KpiCard,
  Notice,
  PageHeader,
  Pager,
  Panel,
  StatusBadge,
  Tabs,
} from "../admin-ui.tsx";
import {
  affiliateStatusLabel,
  channelLabel,
  clickSurfaceLabel,
  formatCount,
  formatDateTime,
  formatPercent,
  hrefWith,
  positiveInt,
} from "../format.ts";

const PATH = "/yonetim/affiliate";
const PAGE_SIZE = 25;
const STATUSES = ["active", "pending", "suspended", "none"] as const;

function windowLabel(days: number): string {
  return days === 1 ? "Son 24 saat" : `Son ${days} gün`;
}

/**
 * Affiliate (karar 0085, `affiliate.read`, yalnızca yönetici). Mağaza çıkışı
 * (`click`) yalnızca attribution toplamı olarak: mağaza, yüzey, kanal, gün.
 * Davranış analitiği değildir. Dönüşüm ve gelir dış entegrasyon gelene kadar
 * yoktur; tahmin edilmez.
 */
export default async function AffiliatePage({
  searchParams,
}: {
  searchParams: Promise<{ gun?: string; durum?: string; sayfa?: string }>;
}) {
  const { actor } = await requireCapability("affiliate.read");
  const params = await searchParams;
  const overview = await getAffiliateOverview(getDatabase(), actor, { days: params.gun });
  const status = (STATUSES as readonly string[]).includes(params.durum ?? "")
    ? (params.durum as (typeof STATUSES)[number])
    : undefined;
  const filtered = status
    ? overview.byMerchant.filter((row) => row.affiliateStatus === status)
    : overview.byMerchant;
  const page = positiveInt(params.sayfa) ?? 1;
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const base = { gun: overview.days, durum: status };
  const label = windowLabel(overview.days).toLowerCase();

  return (
    <div className={styles.page}>
      <PageHeader
        title="Affiliate"
        description={`Mağaza çıkışları ve affiliate kapsamı. ${formatDateTime(overview.generatedAt)} itibarıyla; attribution toplamları.`}
        actions={
          <Tabs
            label="Zaman aralığı"
            items={ANALYTICS_WINDOWS.map((days) => ({
              href: hrefWith(PATH, { gun: days, durum: status }),
              label: windowLabel(days),
              active: days === overview.days,
            }))}
          />
        }
      />

      <div className={styles.kpiGrid}>
        <KpiCard
          label={`Mağaza çıkışı (${label})`}
          value={formatCount(overview.totalClicks)}
          note="Her çıkış attribution kaydı (kural 8)"
          basis="count"
        />
        <KpiCard
          label="Etkin affiliate mağazaya"
          value={formatPercent(overview.clicksToActiveAffiliate, overview.totalClicks)}
          note={`${formatCount(overview.clicksToActiveAffiliate)} çıkış · durum etkin ve deeplink var`}
          basis="count"
        />
        <KpiCard
          label="Creator kaynaklı çıkış"
          value={formatCount(overview.creatorClicks)}
          basis="count"
        />
        <KpiCard
          label="Dönüşüm"
          value={overview.conversions.total > 0 ? formatCount(overview.conversions.inWindow) : "—"}
          note={
            overview.conversions.total > 0
              ? `Toplam ${formatCount(overview.conversions.total)} kayıt`
              : "Affiliate ağından dönüşüm alan entegrasyon yok"
          }
          basis="external"
        />
        <KpiCard
          label="Gelir / komisyon"
          value="—"
          note="Ağ raporu ya da postback gelene kadar bilinmez"
          basis="external"
        />
        <KpiCard
          label="Affiliate kapsamı"
          value={`${formatCount(overview.coverage.withDeeplink)} / ${formatCount(overview.coverage.merchants)}`}
          note="Deeplink şablonu olan mağaza / toplam"
          basis="count"
        />
      </div>

      <Panel
        id="magaza"
        title="Mağazaya göre çıkış"
        description="Çıkışı olmayan mağazalar da listelenir (kapsam görünsün). Komisyon oranı sıralamada belirleyici değildir."
        actions={<DataBasis kind="count" />}
        flush={pageRows.length > 0}
        footer={
          filtered.length > PAGE_SIZE ? (
            <Pager
              prev={page > 1 ? hrefWith(PATH, { ...base, sayfa: page - 1 }) : null}
              next={
                page * PAGE_SIZE < filtered.length
                  ? hrefWith(PATH, { ...base, sayfa: page + 1 })
                  : null
              }
              label={`${formatCount((page - 1) * PAGE_SIZE + 1)}–${formatCount(Math.min(page * PAGE_SIZE, filtered.length))} / ${formatCount(filtered.length)}`}
            />
          ) : null
        }
      >
        <div className={styles.panelBody}>
          <FilterBar action={PATH} resetHref={hrefWith(PATH, { gun: overview.days })}>
            <input type="hidden" name="gun" value={overview.days} />
            <FilterField label="Affiliate durumu">
              <select name="durum" defaultValue={status ?? ""}>
                <option value="">Tümü</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {affiliateStatusLabel(value)}
                  </option>
                ))}
              </select>
            </FilterField>
          </FilterBar>
        </div>
        <DataTable<AffiliateMerchantRow>
          rows={pageRows}
          rowKey={(row) => row.merchantId}
          stack
          empty={<EmptyPanel title="Bu filtrede mağaza yok" />}
          columns={[
            {
              key: "name",
              header: "Mağaza",
              cell: (row) => <Link href={`/yonetim/magazalar/${row.slug}`}>{row.name}</Link>,
            },
            {
              key: "clicks",
              header: "Çıkış",
              numeric: true,
              cell: (row) => formatCount(row.clicks),
            },
            {
              key: "share",
              header: "Pay",
              numeric: true,
              cell: (row) => formatPercent(row.clicks, overview.totalClicks),
            },
            {
              key: "status",
              header: "Affiliate",
              cell: (row) => (
                <StatusBadge tone={row.affiliateStatus === "active" ? "success" : "neutral"}>
                  {affiliateStatusLabel(row.affiliateStatus)}
                </StatusBadge>
              ),
            },
            { key: "network", header: "Ağ", cell: (row) => row.network ?? "—" },
            {
              key: "deeplink",
              header: "Deeplink",
              cell: (row) => (row.hasDeeplink ? "Var" : "Yok"),
            },
            {
              key: "commission",
              header: "Komisyon",
              cell: (row) => (row.hasCommission ? "Tanımlı" : "Yok"),
            },
          ]}
        />
      </Panel>

      <div className={styles.panelGrid}>
        <Panel id="yuzey" title="Yüzey ve kanal" actions={<DataBasis kind="count" />}>
          {overview.totalClicks === 0 ? (
            <p className={styles.muted}>Bu aralıkta mağaza çıkışı yok.</p>
          ) : (
            <KeyValues
              items={[
                ...overview.bySurface.map(
                  (row) =>
                    [
                      `Yüzey: ${clickSurfaceLabel(row.surface)}`,
                      `${formatCount(row.clicks)} · ${formatPercent(row.clicks, overview.totalClicks)}`,
                    ] as [string, string],
                ),
                ...overview.byChannel.map(
                  (row) =>
                    [
                      `Kanal: ${channelLabel(row.channel)}`,
                      `${formatCount(row.clicks)} · ${formatPercent(row.clicks, overview.totalClicks)}`,
                    ] as [string, string],
                ),
              ]}
            />
          )}
        </Panel>

        <Panel id="kapsam" title="Affiliate kapsamı" actions={<DataBasis kind="count" />}>
          <KeyValues
            items={[
              ...overview.coverage.byStatus.map(
                (row) =>
                  [`Durum: ${affiliateStatusLabel(row.status)}`, formatCount(row.count)] as [
                    string,
                    string,
                  ],
              ),
              ["Deeplink şablonu olan", formatCount(overview.coverage.withDeeplink)],
              ["Komisyon tanımlı", formatCount(overview.coverage.withCommission)],
            ]}
          />
        </Panel>
      </div>

      <Panel
        id="gunluk"
        title="Günlük çıkış"
        actions={<DataBasis kind="count" />}
        flush={overview.byDay.length > 0}
      >
        <DataTable
          rows={overview.byDay}
          rowKey={(row) => row.day}
          empty={<EmptyPanel title="Bu aralıkta mağaza çıkışı yok" />}
          columns={[
            { key: "day", header: "Gün", cell: (row) => row.day },
            {
              key: "clicks",
              header: "Çıkış",
              numeric: true,
              cell: (row) => formatCount(row.clicks),
            },
          ]}
        />
      </Panel>

      <Notice title="Attribution sınırları">
        Çıkış kaydı satın alma değildir. Dönüşüm, gelir ve iade affiliate ağının raporu ya da
        postback entegrasyonu olmadan bilinemez; bu ekranda tahmin edilmez. Çıkış kayıtları
        kullanıcı davranışı analizine ya da segmente kaynak olarak kullanılmaz.
      </Notice>
    </div>
  );
}
