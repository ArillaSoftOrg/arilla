import {
  type AdminTrendRow,
  allowedTrendTransitions,
  isTrendStatus,
  listTrendsForAdmin,
  TREND_STATUSES,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  Tabs,
} from "../admin-ui.tsx";
import {
  formatCount,
  formatDateOrDash,
  hrefWith,
  trendStatusLabel,
  trendWindowLabel,
} from "../format.ts";
import { TrendActionsClient } from "./trend-actions-client.tsx";

const PATH = "/yonetim/trendler";

/**
 * Trend yönetimi (karar 0086, `trends.manage`, yalnızca yönetici). Görünürlük
 * public kuralla aynı hesaplanır (yayında + gösterilebilir ürün eşiği).
 * Değişiklikler gerekçe + taze giriş ister ve denetime yazılır; ürün bağları
 * curate işinindir, burada değişmez.
 */
export default async function TrendsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string }>;
}) {
  const { actor } = await requireCapability("trends.manage");
  const params = await searchParams;
  const status = isTrendStatus(params.durum) ? params.durum : undefined;
  const list = await listTrendsForAdmin(getDatabase(), actor, { status });
  const total = list.counts.reduce((sum, row) => sum + row.count, 0);
  const visible = list.rows.filter((row) => row.visible).length;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Trendler"
        description={`Yayın durumu, görünürlük, öne çıkarma ve sıra. Bir trend yalnızca yayındaysa ve en az ${list.minProducts} gösterilebilir ürünü (görselli, fiyatlı, stokta) varsa /trendler'de görünür.`}
        actions={
          <Tabs
            label="Durum"
            items={[
              { href: PATH, label: "Tümü", active: !status, count: total },
              ...TREND_STATUSES.map((value) => ({
                href: hrefWith(PATH, { durum: value }),
                label: trendStatusLabel(value),
                active: status === value,
                count: list.counts.find((row) => row.status === value)?.count ?? 0,
              })),
            ]}
          />
        }
      />

      <Panel
        id="liste"
        title={status ? `${trendStatusLabel(status)} trendler` : "Tüm trendler"}
        description={`Listede ${formatCount(list.rows.length)} trend; şu an görünür: ${formatCount(visible)}. Sıra: public sıralama (sort_order).`}
        actions={<DataBasis kind="count" />}
        flush={list.rows.length > 0}
      >
        <DataTable<AdminTrendRow>
          rows={list.rows}
          rowKey={(row) => row.id}
          stack
          empty={<EmptyPanel title="Bu durumda trend yok" />}
          columns={[
            { key: "order", header: "Sıra", numeric: true, cell: (row) => row.sortOrder },
            {
              key: "title",
              header: "Trend",
              cell: (row) => (
                <span className={styles.list}>
                  <span>{row.title}</span>
                  <span className={styles.meta}>{`/${row.slug} · ${row.category}`}</span>
                </span>
              ),
            },
            {
              key: "status",
              header: "Durum",
              cell: (row) => (
                <StatusBadge tone={row.status === "published" ? "success" : "neutral"}>
                  {trendStatusLabel(row.status)}
                </StatusBadge>
              ),
            },
            {
              key: "visible",
              header: "Görünür",
              cell: (row) =>
                row.visible ? (
                  <StatusBadge tone="success">Görünür</StatusBadge>
                ) : row.status === "published" ? (
                  <StatusBadge tone="warning">{`Eşik altı (${row.showableProducts}/${list.minProducts})`}</StatusBadge>
                ) : (
                  <span className={styles.meta}>—</span>
                ),
            },
            {
              key: "products",
              header: "Ürün (gösterilebilir / bağlı)",
              numeric: true,
              cell: (row) =>
                `${formatCount(row.showableProducts)} / ${formatCount(row.linkedProducts)}`,
            },
            {
              key: "featured",
              header: "Öne çıkan",
              cell: (row) => (row.featured ? "Evet" : "Hayır"),
            },
            {
              key: "window",
              header: "Yayın penceresi",
              cell: (row) => (
                <span className={styles.list}>
                  <span>{trendWindowLabel(row.windowState)}</span>
                  {row.windowState !== "none" ? (
                    <span className={styles.meta}>
                      {`${formatDateOrDash(row.activeFrom)} – ${formatDateOrDash(row.activeUntil)}`}
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              key: "actions",
              header: "İşlem",
              cell: (row) => {
                const index = list.rows.indexOf(row);
                return (
                  <TrendActionsClient
                    row={{
                      id: row.id,
                      title: row.title,
                      status: row.status,
                      featured: row.featured,
                      transitions: allowedTrendTransitions(row.status),
                      belowThreshold: row.showableProducts < list.minProducts,
                      // Sıra komşusu filtre dışı olabilir: yalnızca tam listede kenar gizlenir.
                      isFirst: !status && index === 0,
                      isLast: !status && index === list.rows.length - 1,
                    }}
                  />
                );
              },
            },
          ]}
        />
      </Panel>

      <Notice title="Kapsam">
        Ürün bağları curate toplu işinindir (services/ingest/curate) ve bu ekrandan değişmez. Yayın
        penceresi ve kapak görseli düzenleme bu fazda yok. Her değişiklik gerekçesiyle denetim
        kaydına yazılır.
      </Notice>
    </div>
  );
}
