import {
  countPendingMatches,
  isMatchMethod,
  listMatchQueue,
  listPendingMatchMerchants,
  MATCH_METHODS,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { formatCount, positiveInt } from "../format.ts";
import { MatchQueueClient } from "./match-queue-client.tsx";

/** Tek seferde çekilen grup büyüklüğü; bittiğinde istemci yeni bir grup için sayfayı yeniler. */
const BATCH_SIZE = 25;

export default async function MatchingQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ yontem?: string; magaza?: string }>;
}) {
  await requireCapability("matching.review");
  const params = await searchParams;
  const method = isMatchMethod(params.yontem) ? params.yontem : undefined;
  const merchantId = positiveInt(params.magaza);
  const filter = { method, merchantId };

  const db = getDatabase();
  const [items, total, merchants] = await Promise.all([
    listMatchQueue(db, BATCH_SIZE, filter),
    countPendingMatches(db, filter),
    listPendingMatchMerchants(db),
  ]);

  return (
    <div className={styles.pageNarrow}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Eşleştirme kuyruğu</h1>
        {total > 0 ? (
          <p className={styles.muted}>{`Kuyrukta ${formatCount(total)} eşleştirme bekliyor`}</p>
        ) : null}
        <p className={styles.muted}>
          Kısayollar: A onayla, R reddet (sonra 1–5 neden, 0 nedensiz, Esc vazgeç), S atla ·{" "}
          <Link href="/yonetim/eslestirme/gecmis">İnceleme geçmişi</Link>
        </p>
      </header>

      <form action="/yonetim/eslestirme" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Yöntem</span>
          <select name="yontem" defaultValue={method ?? ""}>
            <option value="">Tümü</option>
            {MATCH_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Mağaza</span>
          <select name="magaza" defaultValue={merchantId ?? ""}>
            <option value="">Tümü</option>
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {`${m.name} (${m.pending})`}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrele</button>
        {method || merchantId ? <Link href="/yonetim/eslestirme">Temizle</Link> : null}
      </form>

      {items.length === 0 ? (
        <EmptyState title="Kuyruk boş." description="İnsan onayı bekleyen bir eşleştirme yok." />
      ) : (
        <MatchQueueClient
          key={`${method ?? ""}-${merchantId ?? ""}-${items[0]?.matchCandidateId ?? 0}`}
          items={items}
        />
      )}
    </div>
  );
}
