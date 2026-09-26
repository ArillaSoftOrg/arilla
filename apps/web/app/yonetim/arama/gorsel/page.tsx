import {
  IMAGE_UPLOAD_STATUSES,
  isImageUploadStatus,
  listImageUploads,
  summarizeImageUploads,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { ErrorNotice, PageHeader, Pager, StatusText, Tile } from "../../admin-ui.tsx";
import {
  formatCostMicros,
  formatCount,
  formatDateTime,
  hrefWith,
  positiveInt,
  statusLabel,
} from "../../format.ts";

/**
 * Görsel arama tanısı (Faz 4). Görsel gösterilmez, nesne anahtarı ve yükleyen
 * kişi dönmez (docs/kvkk.md); yalnızca işleme durumu ve saklama süresi.
 */
export default async function ImageUploadsPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string; once?: string }>;
}) {
  const { actor } = await requireCapability("diagnostics.read");
  const params = await searchParams;
  const status = isImageUploadStatus(params.durum) ? params.durum : undefined;
  const beforeId = positiveInt(params.once);

  const db = getDatabase();
  const [page, summary] = await Promise.all([
    listImageUploads(db, actor, { status, beforeId }),
    summarizeImageUploads(db, actor),
  ]);
  const total7d = Object.values(summary.byStatus7d).reduce((sum, n) => sum + n, 0);

  return (
    <div className={styles.page}>
      <PageHeader title="Görsel arama">
        <p className={styles.muted}>
          Yüklenen görseller burada gösterilmez; ham dosya en fazla 30 gün saklanır.
        </p>
      </PageHeader>

      {summary.purgeOverdue > 0 ? (
        <ErrorNotice>
          {`${formatCount(summary.purgeOverdue)} yüklemenin saklama süresi geçtiği hâlde ham dosyası hâlâ depoda (KVKK). Temizlik işi çalışmıyor olabilir.`}
        </ErrorNotice>
      ) : null}

      <section className={styles.tiles} aria-label="Son 7 gün">
        <Tile
          label="Yükleme (7 gün)"
          value={formatCount(total7d)}
          note={
            Object.entries(summary.byStatus7d)
              .map(([s, n]) => `${statusLabel(s)} ${formatCount(n)}`)
              .join(" · ") || undefined
          }
        />
        <Tile
          label="Embedding çağrısı (7 gün)"
          value={formatCount(summary.embedCalls7d)}
          note={`${formatCount(summary.embedCacheHits7d)} önbellekten`}
        />
        <Tile label="Maliyet (7 gün)" value={formatCostMicros(summary.embedCostMicros7d)} />
      </section>

      <form action="/yonetim/arama/gorsel" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={status ?? ""}>
            <option value="">Tümü</option>
            {IMAGE_UPLOAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrele</button>
        {status ? <Link href="/yonetim/arama/gorsel">Temizle</Link> : null}
      </form>

      {page.rows.length === 0 ? (
        <EmptyState title="Yükleme yok." description="Bu filtreye uyan görsel yüklemesi yok." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Durum</th>
                <th scope="col">Hesap</th>
                <th scope="col">Hash</th>
                <th scope="col">Ham dosya</th>
                <th scope="col">Silinecek</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>
                    <StatusText status={row.status} />
                    {row.rejectionReason ? (
                      <>
                        <br />
                        <span className={styles.meta}>{row.rejectionReason}</span>
                      </>
                    ) : null}
                    {row.hasFace ? (
                      <>
                        <br />
                        <span className={styles.meta}>yüz algılandı</span>
                      </>
                    ) : null}
                  </td>
                  <td>{row.member ? "üye" : "anonim"}</td>
                  <td className={styles.mono}>{row.hashPrefix}</td>
                  <td>
                    {row.purgeOverdue ? (
                      <span className={styles.statusBad}>süresi geçti, hâlâ depoda</span>
                    ) : row.rawStored ? (
                      "depoda"
                    ) : (
                      "silindi"
                    )}
                  </td>
                  <td>{formatDateTime(row.purgeAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        first={beforeId ? hrefWith("/yonetim/arama/gorsel", { durum: status }) : null}
        next={
          page.nextBeforeId
            ? hrefWith("/yonetim/arama/gorsel", { durum: status, once: page.nextBeforeId })
            : null
        }
        nextLabel="Daha eski yüklemeler"
      />
    </div>
  );
}
