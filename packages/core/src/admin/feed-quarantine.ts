/**
 * Karantinadaki besleme (karar 0152/0175). `feeds.sync`, son 3 tam sürümün medyanının %85'inin
 * altındaki dosyayı `too_few_records` ile yazmadan reddeder; karantina kendiliğinden kalkmaz,
 * insan `feeds approve-drop` ile onaylar. 13-25 Kasım 2026'da AliExpress bantları 12 gün bu
 * durumda kaldı, tüm teklifler bayatladı ve panel yalnızca ham `reject_reason` gösteriyordu.
 * Bu modül durumu okur (salt okunur, süre sınırlı) ve bulguya çevirir; kapıyı DEĞİŞTİRMEZ.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { readOnly } from "./bounds.ts";
import type { AdminFinding } from "./severity.ts";

export interface FeedQuarantineItem {
  feedId: number;
  name: string;
  /** Karantinadaki en yeni sürüm. */
  snapshotId: number;
  records: number;
  /** Son 3 tam sürümün kayıt sayısı medyanı (kapının karşılaştırdığı değer). */
  median: number | null;
  /** Son tam sürümden sonraki ilk `too_few_records` reddi. */
  since: Date;
  /** Süresi dolmamış bir onay var (sonraki koşu kabul edecek). */
  approved: boolean;
}

type Row = {
  feed_id: string;
  name: string | null;
  snapshot_id: string;
  records: string | null;
  median: string | null;
  since: string | Date;
  approved: boolean;
};

/**
 * Etkin beslemeler içinde, son tam sürümünden sonra `too_few_records` ile reddedilmiş sürümü
 * olanlar. Kesik (`truncated`) denemeler karantina sayılmaz (koşu içinde yeniden denenir).
 */
export async function listFeedQuarantine(
  db: Database,
  timeoutMs = 2_000,
): Promise<FeedQuarantineItem[]> {
  return readOnly(db, timeoutMs, async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT f.id AS feed_id, f.name, q.id AS snapshot_id, q.record_count AS records,
             m.median, q0.since,
             EXISTS (
               SELECT 1 FROM job_run a
                WHERE a.job = 'feed_drop_approval' AND a.status = 'success'
                  AND a.detail ->> 'feed_id' = f.id::text
                  AND a.started_at > now() - make_interval(
                        days => coalesce((a.detail ->> 'ttl_days')::int, 7))
             ) AS approved
        FROM feed_source f
        LEFT JOIN LATERAL (
             SELECT max(s.started_at) AS at FROM source_snapshot s
              WHERE s.feed_source_id = f.id AND s.status = 'complete'
        ) c ON true
        JOIN LATERAL (
             SELECT s.id, s.record_count FROM source_snapshot s
              WHERE s.feed_source_id = f.id AND s.status = 'rejected'
                AND s.reject_reason = 'too_few_records'
                AND (c.at IS NULL OR s.started_at > c.at)
              ORDER BY s.started_at DESC LIMIT 1
        ) q ON true
        JOIN LATERAL (
             SELECT min(s.started_at) AS since FROM source_snapshot s
              WHERE s.feed_source_id = f.id AND s.status = 'rejected'
                AND s.reject_reason = 'too_few_records'
                AND (c.at IS NULL OR s.started_at > c.at)
        ) q0 ON true
        LEFT JOIN LATERAL (
             SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t.record_count) AS median
               FROM (SELECT s.record_count FROM source_snapshot s
                      WHERE s.feed_source_id = f.id AND s.status = 'complete'
                        AND s.record_count IS NOT NULL
                      ORDER BY s.completed_at DESC LIMIT 3) t
        ) m ON true
       WHERE f.status = 'active'
       ORDER BY f.id
    `);
    return result.rows.map((row) => ({
      feedId: Number(row.feed_id),
      name: row.name ?? `besleme ${row.feed_id}`,
      snapshotId: Number(row.snapshot_id),
      records: Number(row.records ?? 0),
      median: row.median === null ? null : Math.round(Number(row.median)),
      since: new Date(row.since),
      approved: row.approved === true,
    }));
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function count(n: number): string {
  return n.toLocaleString("tr-TR");
}

/** `feeds` CLI çağrısı; docs/ops.md "Karantinadaki küçülmeyi onaylama". */
export function quarantineCommand(item: Pick<FeedQuarantineItem, "feedId" | "snapshotId">): string {
  return `python -m feeds approve-drop --feed ${item.feedId} --snapshot ${item.snapshotId} --level --ttl-days 7 --by <ad> --reason "<15-120 karakter gerekçe>" --confirm`;
}

/**
 * Saf: karantina bulguları. Onay bekleyen besleme `warning` (fiyatlar yenilenmiyor ama veri
 * kaybı yok; `critical` 0052'de veri kaybına ayrılmış), onay verilmiş ve sonraki koşuyu bekleyen
 * besleme `info`.
 */
export function feedQuarantineFindings(
  items: readonly FeedQuarantineItem[],
  now: Date,
): AdminFinding[] {
  return items.map((item) => {
    const days = Math.max(0, Math.floor((now.getTime() - item.since.getTime()) / DAY_MS));
    const ratio =
      item.median && item.median > 0 ? ` (%${Math.round((item.records / item.median) * 100)})` : "";
    const evidence = `Son dosya ${count(item.records)} kayıt; önceki 3 tam sürümün medyanı ${
      item.median === null ? "—" : count(item.median)
    }${ratio}. Sürüm ${item.snapshotId}.`;
    const base = {
      href: "/yonetim/ingest/beslemeler",
      capability: "ingest.read" as const,
      evidence,
      evidenceAt: now,
    };
    if (item.approved) {
      return {
        ...base,
        key: `feeds.quarantine.${item.feedId}`,
        severity: "info" as const,
        title: `${item.name}: küçülme onaylandı, sonraki koşu bekleniyor`,
        meaning: "Onay süresi içinde sonraki günlük koşu bu seviyedeki dosyayı yazacak.",
        action:
          "Sonraki koşudan sonra sürümün 'tam' olduğunu ve fiyatların yenilendiğini doğrulayın.",
      };
    }
    return {
      ...base,
      key: `feeds.quarantine.${item.feedId}`,
      severity: "warning" as const,
      title: `${item.name} ${days === 0 ? "bugün" : `${count(days)} gündür`} karantinada: onay bekliyor`,
      meaning:
        "Dosya, son tam sürümlere göre çok küçük olduğu için yazılmadı. Karantina kendiliğinden kalkmaz; bu beslemenin teklif ve fiyatları yenilenmiyor.",
      action: `Küçülmenin meşru olduğunu doğrulayın (kesik dosya değil, kaynak gerçekten küçüldü), sonra VPS'te onaylayın: ${quarantineCommand(item)}`,
    };
  });
}
