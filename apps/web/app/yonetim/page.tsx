import { getAdminOverview, MATCH_QUEUE_ALERT_THRESHOLD } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../lib/dal.ts";
import styles from "./admin.module.css";
import { formatCostMicros, formatCount, formatDateTime, statusLabel } from "./format.ts";

function Tile({
  label,
  value,
  note,
  warning = false,
}: {
  label: string;
  value: string;
  note?: string;
  warning?: boolean;
}) {
  return (
    <div className={warning ? `${styles.tile} ${styles.tileWarning}` : styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note ? <span className={styles.tileNote}>{note}</span> : null}
    </div>
  );
}

function breakdown(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "Kayıt yok";
  return entries.map(([status, n]) => `${statusLabel(status)} ${formatCount(n)}`).join(" · ");
}

function total(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, n) => sum + n, 0);
}

/** docs/decisions/0039 madde 7: yalnızca veritabanında gerçekten var olan sayılar. */
export default async function AdminOverviewPage() {
  const { actor } = await requireCapability("admin.access");
  const overview = await getAdminOverview(getDatabase(), actor);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Genel bakış</h1>
        <p className={styles.muted}>{`Son güncelleme ${formatDateTime(overview.generatedAt)}`}</p>
      </header>

      <section className={styles.tiles} aria-label="Katalog ve kuyruk">
        <Tile
          label="Bekleyen eşleştirme"
          value={formatCount(overview.pendingMatches)}
          note={
            overview.pendingMatches > MATCH_QUEUE_ALERT_THRESHOLD
              ? `${MATCH_QUEUE_ALERT_THRESHOLD} eşiğinin üstünde`
              : undefined
          }
          warning={overview.pendingMatches > MATCH_QUEUE_ALERT_THRESHOLD}
        />
        <Tile label="Eşleşmemiş aktif teklif" value={formatCount(overview.unmatchedOffers)} />
        <Tile
          label="Aktif mağaza"
          value={`${formatCount(overview.merchants.active)} / ${formatCount(overview.merchants.total)}`}
        />
        <Tile label="Yeni kullanıcı (7 gün)" value={formatCount(overview.newUsers7d)} />
      </section>

      <section className={styles.tiles} aria-label="Kullanıcı akışları ve maliyet">
        <Tile
          label="Veri toplama koşuları (24 saat)"
          value={formatCount(total(overview.ingest.runsLast24h))}
          note={breakdown(overview.ingest.runsLast24h)}
        />
        <Tile
          label="Link araması (7 gün)"
          value={formatCount(total(overview.linkRequests7d))}
          note={breakdown(overview.linkRequests7d)}
        />
        <Tile
          label="Görsel yükleme (7 gün)"
          value={formatCount(total(overview.imageUploads7d))}
          note={breakdown(overview.imageUploads7d)}
        />
        <Tile
          label="Model maliyeti (24 saat)"
          value={formatCostMicros(overview.apiUsage.last24hCostMicros)}
          note={`7 gün: ${formatCostMicros(overview.apiUsage.last7dCostMicros)} · ${formatCount(
            overview.apiUsage.last7dCalls,
          )} çağrı, ${formatCount(overview.apiUsage.last7dCacheHits)} önbellekten`}
        />
      </section>

      <section className={styles.pageHeader} aria-labelledby="dikkat">
        <h2 id="dikkat" className={styles.sectionTitle}>
          Dikkat gerektiren mağazalar
        </h2>
        {overview.ingest.attention.length === 0 ? (
          <p className={styles.muted}>Son koşusu başarısız ya da kısmi biten mağaza yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Mağaza</th>
                  <th scope="col">Son koşu</th>
                  <th scope="col">Başlangıç</th>
                </tr>
              </thead>
              <tbody>
                {overview.ingest.attention.map((item) => (
                  <tr key={item.merchantId}>
                    <td>{item.merchantName}</td>
                    <td>{statusLabel(item.status)}</td>
                    <td>{formatDateTime(item.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.pageHeader} aria-labelledby="araclar">
        <h2 id="araclar" className={styles.sectionTitle}>
          Araçlar
        </h2>
        <ul className={styles.list}>
          <li>
            <Link href="/yonetim/eslestirme">Eşleştirme kuyruğu</Link>
          </li>
          <li>
            <Link href="/yonetim/sozluk">Sözlük</Link>
          </li>
        </ul>
      </section>

      <p className={styles.muted}>
        Arama sayısı ve sonuçsuz arama oranı burada yok: arama günlüğü henüz tutulmuyor.
      </p>
    </div>
  );
}
