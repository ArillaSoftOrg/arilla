import {
  isLinkErrorCode,
  isLinkStatus,
  LINK_ERROR_CODES,
  LINK_STATUSES,
  listLinkRequests,
  summarizeLinkRequests,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader, Pager, StatusText, Tile } from "../../admin-ui.tsx";
import {
  formatCount,
  formatDateTime,
  formatDuration,
  hrefWith,
  statusLabel,
} from "../../format.ts";

interface LinkSearchParams {
  durum?: string;
  hata?: string;
  alan?: string;
  imlec?: string;
}

/**
 * Link araması tanısı (Faz 2). Kimin aradığı (oturum, kullanıcı) ve ham
 * yapıştırılan adres gösterilmez; adres sorgu dizisi olmadan gösterilir.
 */
export default async function LinkRequestsPage({
  searchParams,
}: {
  searchParams: Promise<LinkSearchParams>;
}) {
  const { actor } = await requireCapability("diagnostics.read");
  const params = await searchParams;
  const status = isLinkStatus(params.durum) ? params.durum : undefined;
  const errorCode = isLinkErrorCode(params.hata) ? params.hata : undefined;
  const host = params.alan?.trim().toLowerCase().slice(0, 253) || undefined;

  const db = getDatabase();
  const [page, summary] = await Promise.all([
    listLinkRequests(db, actor, { status, errorCode, host, cursor: params.imlec }),
    summarizeLinkRequests(db, actor),
  ]);
  const base = { durum: status, hata: errorCode, alan: host };
  const resolved = summary.byStatus.resolved ?? 0;
  const topErrors = Object.entries(summary.byErrorCode)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className={styles.page}>
      <PageHeader title="Link araması">
        <p className={styles.muted}>Son 7 gün özeti ve istek bazında çözümleme durumu.</p>
      </PageHeader>

      <section className={styles.tiles} aria-label="Son 7 gün">
        <Tile label="İstek (7 gün)" value={formatCount(summary.total)} />
        <Tile
          label="Çözülen"
          value={formatCount(resolved)}
          note={
            summary.total > 0
              ? `%${Math.round((resolved / summary.total) * 100).toLocaleString("tr-TR")}`
              : undefined
          }
        />
        <Tile label="Başarısız" value={formatCount(summary.byStatus.failed ?? 0)} />
        <Tile
          label="En sık hata"
          value={topErrors[0]?.[0] ?? "—"}
          note={topErrors.map(([code, n]) => `${code} ${formatCount(n)}`).join(" · ") || undefined}
        />
      </section>

      <form action="/yonetim/arama/link" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={status ?? ""}>
            <option value="">Tümü</option>
            {LINK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Hata kodu</span>
          <select name="hata" defaultValue={errorCode ?? ""}>
            <option value="">Tümü</option>
            {LINK_ERROR_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Alan adı (tam)</span>
          <input type="search" name="alan" defaultValue={host ?? ""} maxLength={253} />
        </label>
        <button type="submit">Filtrele</button>
        {status || errorCode || host ? <Link href="/yonetim/arama/link">Temizle</Link> : null}
      </form>

      {page.rows.length === 0 ? (
        <EmptyState title="İstek yok." description="Bu filtreye uyan link araması yok." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Alan adı</th>
                <th scope="col">Durum</th>
                <th scope="col">Süre</th>
                <th scope="col">Sonuç</th>
                <th scope="col">Ayrıntı</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>{row.host ?? "—"}</td>
                  <td>
                    <StatusText status={row.status} />
                    {row.errorCode ? (
                      <>
                        <br />
                        <span className={styles.meta}>{row.errorCode}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{formatDuration(row.durationMs)}</td>
                  <td>
                    {row.productSlug ? (
                      <Link href={`/urun/${row.productSlug}`}>Ürün sayfası</Link>
                    ) : row.offerId ? (
                      `Teklif #${row.offerId} (henüz eşleşmedi)`
                    ) : (
                      "—"
                    )}
                    {row.hasImageEmbedding ? (
                      <>
                        <br />
                        <span className={styles.meta}>görsel vektörü var</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <details>
                      <summary className={styles.detailsSummary}>Aç</summary>
                      <dl className={styles.keyValues}>
                        <dt>Adres</dt>
                        <dd className={styles.mono}>{row.url ?? "—"}</dd>
                        {Object.entries(row.source).map(([key, value]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <dt>{key}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                        {row.errorText ? (
                          <>
                            <dt>Hata</dt>
                            <dd className={styles.mono}>{row.errorText}</dd>
                          </>
                        ) : null}
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        first={params.imlec ? hrefWith("/yonetim/arama/link", base) : null}
        next={
          page.nextCursor
            ? hrefWith("/yonetim/arama/link", { ...base, imlec: page.nextCursor })
            : null
        }
        nextLabel="Daha eski istekler"
      />
    </div>
  );
}
