import type { IngestRunRow } from "@arilla/core";
import Link from "next/link";
import styles from "./admin.module.css";
import { StatusText } from "./admin-ui.tsx";
import { formatCount, formatDateTime, formatDuration } from "./format.ts";

const REFUSED_LABELS: Record<string, string> = {
  merchant_inactive: "mağaza kapalı",
  currency_unverified: "para birimi doğrulanmadı",
  currency_not_try: "para birimi TRY değil",
  feed_config_invalid: "feed ayarı geçersiz",
};

/** Koşu geçmişi tablosu. Hata metni sunucuda token'lardan arındırılmış gelir; düz metin render edilir. */
export function IngestRunsTable({
  rows,
  showMerchant,
}: {
  rows: IngestRunRow[];
  showMerchant: boolean;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Başlangıç</th>
            {showMerchant ? <th scope="col">Mağaza</th> : null}
            <th scope="col">Durum</th>
            <th scope="col">Süre</th>
            <th scope="col" className={styles.num}>
              Görülen
            </th>
            <th scope="col" className={styles.num}>
              Yeni / güncel
            </th>
            <th scope="col" className={styles.num}>
              Fiyat noktası
            </th>
            <th scope="col">Hata</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => (
            <tr key={run.id}>
              <td>{formatDateTime(run.startedAt)}</td>
              {showMerchant ? (
                <td>
                  <Link href={`/yonetim/magazalar/${run.merchantSlug}`}>{run.merchantName}</Link>
                </td>
              ) : null}
              <td>
                <StatusText status={run.status} />
                {run.refusedCode ? (
                  <>
                    <br />
                    <span className={styles.meta}>
                      {`kapı: ${REFUSED_LABELS[run.refusedCode] ?? run.refusedCode}`}
                    </span>
                  </>
                ) : null}
              </td>
              <td>{formatDuration(run.durationMs)}</td>
              <td className={styles.num}>{formatCount(run.offersSeen)}</td>
              <td className={styles.num}>
                {`${formatCount(run.offersCreated)} / ${formatCount(run.offersUpdated)}`}
              </td>
              <td className={styles.num}>{formatCount(run.pricePointsWritten)}</td>
              <td>
                {run.errorText ? (
                  <details>
                    <summary className={styles.detailsSummary}>Ayrıntı</summary>
                    <pre className={styles.mono}>{run.errorText}</pre>
                  </details>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
