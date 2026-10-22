/**
 * Keşif defterinde kaldırılma takibi (karar 0140).
 *
 * Bir ürün yalnızca BAŞARILI ve KAPSAMI DOĞRULANMIŞ tam taramada görülmediyse "eksik"
 * sayılır. Ardışık `REMOVAL_MISSED_SCANS` tam taramada görülmeyen satır `removed` olur.
 * Kısmi, başarısız, engellenmiş veya boş birim içeren koşu hiçbir sayımı değiştirmez.
 * Hiçbir satır silinmez.
 */
import { catalogDiscovery, collectionUnit, type Database } from "@arilla/db";
import { and, eq, ne, or, sql } from "drizzle-orm";

export const REMOVAL_MISSED_SCANS = 2;

export interface ScanUnit {
  kind: string;
  status: string;
}

export type ScanVerdict =
  | { complete: true; units: number }
  | {
      complete: false;
      reason: "no_discovery_units" | "unit_pending" | "unit_failed" | "unit_blocked" | "unit_empty";
    };

/**
 * Koşunun birimleri tam taramayı kanıtlıyor mu? Yalnızca `sitemap_file` birimleri bakılır.
 * Tek bir birim bile tamamlanmamışsa koşu tam sayılmaz.
 */
export function verifyFullScan(units: readonly ScanUnit[]): ScanVerdict {
  const files = units.filter((u) => u.kind === "sitemap_file");
  if (files.length === 0) return { complete: false, reason: "no_discovery_units" };
  for (const u of files) {
    if (u.status === "done") continue;
    if (u.status === "failed") return { complete: false, reason: "unit_failed" };
    if (u.status === "blocked") return { complete: false, reason: "unit_blocked" };
    // `empty` bilinçli olarak engeller: geçici bir hata boş dosya gibi görünebilir.
    if (u.status === "empty") return { complete: false, reason: "unit_empty" };
    return { complete: false, reason: "unit_pending" };
  }
  return { complete: true, units: files.length };
}

export interface PresenceResult {
  applied: boolean;
  verdict: ScanVerdict | null;
  seen: number;
  missed: number;
  removed: number;
}

/**
 * Kapanan koşuyu kaldırılma hesabına işler. `tx` closeCollectionRun'un transaction'ıdır;
 * sayım ve durum aynı işlemde yazılır. Aynı koşu iki kez uygulanmaz.
 */
export async function applyRunPresence(
  tx: Database,
  input: { source: string; runId: number },
): Promise<PresenceResult> {
  const units = await tx
    .select({ kind: collectionUnit.kind, status: collectionUnit.status })
    .from(collectionUnit)
    .where(eq(collectionUnit.runId, input.runId));
  const verdict = verifyFullScan(units);
  if (!verdict.complete) return { applied: false, verdict, seen: 0, missed: 0, removed: 0 };

  // Kontrol noktası: yalnızca daha yeni bir koşu ilerletebilir (idempotent, geri gitmez).
  const claimed = await tx.execute(sql`
    INSERT INTO catalog_discovery_scan_state (source, last_finalized_run_id)
    VALUES (${input.source}, ${input.runId})
    ON CONFLICT (source) DO UPDATE
       SET last_finalized_run_id = excluded.last_finalized_run_id, finalized_at = now()
     WHERE catalog_discovery_scan_state.last_finalized_run_id < excluded.last_finalized_run_id
    RETURNING last_finalized_run_id
  `);
  if (claimed.rows.length === 0) {
    return { applied: false, verdict: null, seen: 0, missed: 0, removed: 0 };
  }

  // Yalnızca değişen satırlar yazılır: sağlıklı satırların yeniden yazılması WAL üretir.
  const seenRows = await tx
    .update(catalogDiscovery)
    .set({ missedScans: 0, presence: "present" })
    .where(
      and(
        eq(catalogDiscovery.source, input.source),
        eq(catalogDiscovery.lastSeenRunId, input.runId),
        or(ne(catalogDiscovery.missedScans, 0), ne(catalogDiscovery.presence, "present")),
      ),
    )
    .returning({ id: catalogDiscovery.externalId });

  const missedRows = await tx.execute(sql`
    UPDATE catalog_discovery
       SET missed_scans = LEAST(missed_scans + 1, 32767),
           presence = CASE WHEN missed_scans + 1 >= ${REMOVAL_MISSED_SCANS}
                           THEN 'removed' ELSE 'missing' END
     WHERE source = ${input.source}
       AND last_seen_run_id <> ${input.runId}
       AND presence <> 'removed'
    RETURNING presence
  `);
  const removed = missedRows.rows.filter((r) => (r as { presence: string }).presence === "removed");

  return {
    applied: true,
    verdict,
    seen: seenRows.length,
    missed: missedRows.rows.length,
    removed: removed.length,
  };
}
