import { countPendingMatches, listMatchQueue } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { formatCount } from "../format.ts";
import { MatchQueueClient } from "./match-queue-client.tsx";

/** Tek seferde çekilen grup büyüklüğü; bittiğinde istemci yeni bir grup için sayfayı yeniler. */
const BATCH_SIZE = 25;

export default async function MatchingQueuePage() {
  await requireCapability("matching.review");

  const db = getDatabase();
  const [items, total] = await Promise.all([
    listMatchQueue(db, BATCH_SIZE),
    countPendingMatches(db),
  ]);

  return (
    <div className={styles.pageNarrow}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Eşleştirme kuyruğu</h1>
        {total > 0 ? (
          <p className={styles.muted}>{`Kuyrukta ${formatCount(total)} eşleştirme bekliyor`}</p>
        ) : null}
        <p className={styles.muted}>Kısayollar: A onayla, R reddet, S atla</p>
      </header>

      {items.length === 0 ? (
        <EmptyState title="Kuyruk boş." description="İnsan onayı bekleyen bir eşleştirme yok." />
      ) : (
        <MatchQueueClient items={items} />
      )}
    </div>
  );
}
