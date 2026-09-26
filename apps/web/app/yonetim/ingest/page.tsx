import { INGEST_STATUSES, isIngestStatus, listIngestRuns } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { PageHeader, Pager } from "../admin-ui.tsx";
import { hrefWith, positiveInt, statusLabel } from "../format.ts";
import { IngestRunsTable } from "../ingest-runs-table.tsx";

/**
 * Tüm mağazaların veri toplama koşuları (Faz 2). Salt okunur: burada
 * "şimdi çalıştır" ya da yeniden deneme YOK (docs/decisions/0039).
 */
export default async function IngestRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string; magaza?: string; once?: string }>;
}) {
  const { actor } = await requireCapability("ingest.read");
  const params = await searchParams;
  const status = isIngestStatus(params.durum) ? params.durum : undefined;
  const merchantId = positiveInt(params.magaza);
  const beforeId = positiveInt(params.once);

  const runs = await listIngestRuns(getDatabase(), actor, { status, merchantId, beforeId });
  const base = { durum: status, magaza: merchantId };

  return (
    <div className={styles.page}>
      <PageHeader title="Veri toplama">
        <p className={styles.muted}>
          Koşular komut satırı ya da zamanlayıcıdan çalışır; bu ekran yalnızca izlerini gösterir.
          Hata metinlerindeki adreslerden sorgu dizisi çıkarılmıştır.
        </p>
      </PageHeader>

      <form action="/yonetim/ingest" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={status ?? ""}>
            <option value="">Tümü</option>
            {INGEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {merchantId ? <input type="hidden" name="magaza" value={merchantId} /> : null}
        <button type="submit">Filtrele</button>
        {status || merchantId ? <Link href="/yonetim/ingest">Temizle</Link> : null}
      </form>

      {runs.rows.length === 0 ? (
        <EmptyState title="Koşu yok." description="Bu filtreye uyan veri toplama koşusu yok." />
      ) : (
        <IngestRunsTable rows={runs.rows} showMerchant />
      )}

      <Pager
        first={beforeId ? hrefWith("/yonetim/ingest", base) : null}
        next={
          runs.nextBeforeId
            ? hrefWith("/yonetim/ingest", { ...base, once: runs.nextBeforeId })
            : null
        }
        nextLabel="Daha eski koşular"
      />
    </div>
  );
}
