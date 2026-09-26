import { isReviewReason, listMatchHistory } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader, Pager, StatusText } from "../../admin-ui.tsx";
import {
  formatDateOrDash,
  hrefWith,
  positiveInt,
  REVIEW_REASON_LABELS,
  reviewReasonLabel,
} from "../../format.ts";

/** İnsan kararlarının geçmişi (Faz 3): kim, ne zaman, hangi nedenle. */
export default async function MatchHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string; neden?: string; once?: string }>;
}) {
  const { actor } = await requireCapability("matching.review");
  const params = await searchParams;
  const status =
    params.durum === "accepted" || params.durum === "rejected" ? params.durum : undefined;
  const reason =
    isReviewReason(params.neden) || params.neden === "superseded" ? params.neden : undefined;
  const beforeId = positiveInt(params.once);

  const history = await listMatchHistory(getDatabase(), actor, { status, reason, beforeId });
  const base = { durum: status, neden: reason };

  return (
    <div className={styles.page}>
      <PageHeader title="İnceleme geçmişi">
        <p className={styles.muted}>
          <Link href="/yonetim/eslestirme">Eşleştirme kuyruğu</Link> / insan kararları. Otomatik
          kabuller burada değil.
        </p>
      </PageHeader>

      <form action="/yonetim/eslestirme/gecmis" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Karar</span>
          <select name="durum" defaultValue={status ?? ""}>
            <option value="">Tümü</option>
            <option value="accepted">Onaylandı</option>
            <option value="rejected">Reddedildi</option>
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Neden</span>
          <select name="neden" defaultValue={reason ?? ""}>
            <option value="">Tümü</option>
            {Object.entries(REVIEW_REASON_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrele</button>
        {status || reason ? <Link href="/yonetim/eslestirme/gecmis">Temizle</Link> : null}
      </form>

      {history.rows.length === 0 ? (
        <EmptyState title="Karar yok." description="Bu filtreye uyan bir inceleme kararı yok." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">İnceleyen</th>
                <th scope="col">Karar</th>
                <th scope="col">Neden</th>
                <th scope="col">Teklif</th>
                <th scope="col">Ürün</th>
                <th scope="col" className={styles.num}>
                  Skor
                </th>
              </tr>
            </thead>
            <tbody>
              {history.rows.map((row) => (
                <tr key={row.matchCandidateId}>
                  <td>{formatDateOrDash(row.reviewedAt)}</td>
                  <td>{row.reviewerLabel ?? "—"}</td>
                  <td>
                    <StatusText status={row.status} />
                  </td>
                  <td>{row.status === "rejected" ? reviewReasonLabel(row.reviewReason) : "—"}</td>
                  <td>
                    {row.offerTitle}
                    <br />
                    <span className={styles.meta}>{row.merchantName}</span>
                  </td>
                  <td>
                    <Link href={`/yonetim/katalog/urunler/${row.productId}`}>
                      {row.productTitle}
                    </Link>
                  </td>
                  <td className={styles.num}>{`${row.score.toFixed(2)} · ${row.method}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        first={beforeId ? hrefWith("/yonetim/eslestirme/gecmis", base) : null}
        next={
          history.nextBeforeId
            ? hrefWith("/yonetim/eslestirme/gecmis", { ...base, once: history.nextBeforeId })
            : null
        }
        nextLabel="Daha eski kararlar"
      />
    </div>
  );
}
