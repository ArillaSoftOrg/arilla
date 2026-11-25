/**
 * Zamanlanmis yonetici tarayicisi toplamasi bulgulari (karar 0221). Durumu salt okunur ve sure
 * sinirli okur; zamanlamayi DEGISTIRMEZ. Iki bulgu:
 *  - son zamanlanmis koşu basarisiz/yarim (engel, yarida kalma, kota reddi, hata);
 *  - zamanlama acik ve kota izin verdigi halde koşu gecikti (tarayici/eklenti calismiyor olabilir).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { isScheduleFlagEnabled } from "../catalog-collection/schedule.ts";
import {
  isFailedOutcome,
  OVERDUE_GRACE_MS,
  type ScheduleOutcome,
} from "../catalog-collection/schedule-logic.ts";
import { readOnly } from "./bounds.ts";
import type { AdminFinding } from "./severity.ts";

export interface CollectionScheduleItem {
  source: string;
  /** Zamanlama satiri, kaynak politikasi ve ortam bayragi birlikte acik. */
  active: boolean;
  lastOutcome: ScheduleOutcome | null;
  lastErrorCode: string | null;
  lastFinishedAt: Date | null;
  /** Kotanin izin verdigi en erken zaman (son sayilan koşu + aralik); hic koşu yoksa null. */
  dueAt: Date | null;
  /** Bu takvim ayinin koşu hakki doldu ya da acik koşu var: gecikme sayilmaz. */
  blocked: boolean;
}

type Row = {
  source: string;
  enabled: boolean;
  source_enabled: boolean;
  last_outcome: string | null;
  last_error_code: string | null;
  last_finished_at: string | Date | null;
  due_at: string | Date | null;
  blocked: boolean;
};

export async function listCollectionSchedules(
  db: Database,
  env: Readonly<Record<string, string | undefined>> = process.env,
  timeoutMs = 2_000,
): Promise<CollectionScheduleItem[]> {
  return readOnly(db, timeoutMs, async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT s.source, s.enabled, cs.enabled AS source_enabled, s.last_outcome,
             s.last_error_code, s.last_finished_at,
             last.at + make_interval(days => cs.min_interval_days) AS due_at,
             (EXISTS (SELECT 1 FROM collection_run r
                       WHERE r.source = s.source AND r.status = 'open')
              OR (cs.max_runs_per_month IS NOT NULL AND (
                    SELECT count(*) FROM collection_run r
                     WHERE r.source = s.source AND r.status <> 'released'
                       AND r.reserved_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  ) >= cs.max_runs_per_month)) AS blocked
        FROM collection_schedule s
        JOIN collection_source cs ON cs.source = s.source
        LEFT JOIN LATERAL (
             SELECT max(r.reserved_at) AS at FROM collection_run r
              WHERE r.source = s.source AND r.status <> 'released'
        ) last ON true
       ORDER BY s.source
    `);
    return result.rows.map((row) => ({
      source: row.source,
      active: row.enabled && row.source_enabled && isScheduleFlagEnabled(row.source, env),
      lastOutcome: (row.last_outcome as ScheduleOutcome | null) ?? null,
      lastErrorCode: row.last_error_code,
      lastFinishedAt: row.last_finished_at ? new Date(row.last_finished_at) : null,
      dueAt: row.due_at ? new Date(row.due_at) : null,
      blocked: row.blocked === true,
    }));
  });
}

const FAILURE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function label(source: string): string {
  return source === "trendyol" ? "Trendyol" : source;
}

function href(source: string): string {
  return `/yonetim/katalog/toplama/${source}`;
}

/** Saf: zamanlama bulgulari. */
export function collectionScheduleFindings(
  items: readonly CollectionScheduleItem[],
  now: Date,
): AdminFinding[] {
  const out: AdminFinding[] = [];
  for (const item of items) {
    const base = {
      href: href(item.source),
      capability: "catalog.write" as const,
    };
    if (
      isFailedOutcome(item.lastOutcome) &&
      item.lastFinishedAt &&
      now.getTime() - item.lastFinishedAt.getTime() <= FAILURE_WINDOW_MS
    ) {
      out.push({
        ...base,
        key: `collection.schedule_failed.${item.source}`,
        severity: "warning",
        title: `${label(item.source)} zamanlanmış toplaması başarısız: ${item.lastOutcome}`,
        meaning:
          "Son otomatik koşu tamamlanmadı; teklif ve fiyatlar bu kaynakta yenilenmedi. Engel ya da sayfa yapısı değişikliğinde yeniden deneme yapılmaz.",
        evidence: item.lastErrorCode ? `Kod: ${item.lastErrorCode}.` : null,
        action:
          "Toplama sayfasında son koşuyu inceleyin. Engel ya da yapı değişikliğiyse kaynağı elle kontrol edin; kota hakkı harcandıysa sonraki izinli zamanı bekleyin.",
        evidenceAt: item.lastFinishedAt,
      });
    }
    if (!item.active || item.blocked) continue;
    const due = item.dueAt ?? item.lastFinishedAt;
    // Hic koşu olmamissa gecikme olculmez (ilk koşu zamanlama acilinca ilk saatte denenir).
    if (due !== null && now.getTime() - due.getTime() > OVERDUE_GRACE_MS) {
      out.push({
        ...base,
        key: `collection.schedule_overdue.${item.source}`,
        severity: "warning",
        title: `${label(item.source)} zamanlanmış toplaması gecikti`,
        meaning:
          "Zamanlama açık ve kota izin veriyor ama koşu açılmadı. Yöneticinin tarayıcısı ya da eklentisi çalışmıyor, oturum kapalı ya da yönetim sayfası açılamıyor olabilir.",
        evidence: `Koşu en erken ${due.toISOString()} tarihinde açılabilirdi.`,
        action:
          "Eklentinin yüklü ve tarayıcının açık olduğunu, yönetim oturumunun sürdüğünü doğrulayın; gerekirse toplama sayfasını açıp koşuyu elle başlatın.",
        evidenceAt: now,
      });
    }
  }
  return out;
}
