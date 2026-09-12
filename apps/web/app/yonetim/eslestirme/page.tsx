import { listMatchQueue } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import { requireRole } from "../../lib/dal.ts";
import { MatchQueueClient } from "./match-queue-client.tsx";

/** Tek seferde çekilen grup büyüklüğü; bittiğinde istemci yeni bir grup için sayfayı yeniler. */
const BATCH_SIZE = 25;

export default async function MatchingQueuePage() {
  await requireRole(["moderator", "admin"]);

  const db = getDatabase();
  const items = await listMatchQueue(db, BATCH_SIZE);

  return (
    <main style={{ padding: 24, display: "grid", gap: 16, maxWidth: 720 }}>
      <div>
        <h1 style={{ margin: 0 }}>Eşleştirme kuyruğu</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-muted)" }}>
          {items.length > 0
            ? `Kuyrukta ${items.length} eşleştirme bekliyor`
            : "Kuyrukta eşleştirme yok"}
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-muted)" }}>
          Kısayollar: A onayla, R reddet, S atla
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState title="Kuyruk boş." description="İnsan onayı bekleyen bir eşleştirme yok." />
      ) : (
        <MatchQueueClient items={items} />
      )}
    </main>
  );
}
