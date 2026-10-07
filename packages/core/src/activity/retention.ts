/**
 * Kişisel veri saklama süreleri (docs/decisions/0049 §10). Günlük
 * `/api/cron/cleanup-auth` işinden çağrılır; yeni bir cron açılmaz.
 *
 * | Veri                         | Süre                         |
 * | ---------------------------- | ---------------------------- |
 * | `user_activity_event`        | 180 gün                      |
 * | `user_activity_event.query_norm` | 90 günde NULL            |
 * | `auth_event`                 | 1 yıl                        |
 * | `user_consent.ip`            | 1 yıl sonra NULL (kvkk.md)   |
 *
 * Yetki en aza indirilmiştir (0036): uygulama rolü `auth_event` ve
 * `user_activity_event`'te UPDATE yapamaz (yalnızca `query_norm`), ama
 * silebilir. SECURITY DEFINER istisnası (0021) açılmaz.
 *
 * İşler küçük partilerle ve sınırlı sayıda turla yürür. Kilit tutmaz,
 * yarıda kesilirse ertesi gün kaldığı yerden devam eder (idempotent).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

export const ACTIVITY_EVENT_RETENTION_DAYS = 180;
export const QUERY_NORM_RETENTION_DAYS = 90;
export const AUTH_EVENT_RETENTION_DAYS = 365;
export const CONSENT_IP_RETENTION_DAYS = 365;

export interface PurgeOptions {
  now?: Date;
  batchSize?: number;
  /** Tek koşuda iş başına en fazla tur (zaman bütçesi). */
  maxBatches?: number;
}

export interface PurgeResult {
  activityEventsDeleted: number;
  queryNormsCleared: number;
  authEventsDeleted: number;
  consentIpsCleared: number;
}

async function inBatches(
  run: () => Promise<number>,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const affected = await run();
    total += affected;
    if (affected < batchSize) break;
  }
  return total;
}

export async function purgeExpiredActivity(
  db: Pick<Database, "execute">,
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 5_000;
  const maxBatches = options.maxBatches ?? 20;
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const activityCutoff = before(ACTIVITY_EVENT_RETENTION_DAYS);
  const activityEventsDeleted = await inBatches(
    async () =>
      (
        await db.execute(sql`
          DELETE FROM user_activity_event
           WHERE id IN (SELECT id FROM user_activity_event
                         WHERE created_at < ${activityCutoff}
                         ORDER BY created_at LIMIT ${batchSize})
        `)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );

  const queryCutoff = before(QUERY_NORM_RETENTION_DAYS);
  const queryNormsCleared = await inBatches(
    async () =>
      (
        await db.execute(sql`
          UPDATE user_activity_event SET query_norm = NULL
           WHERE id IN (SELECT id FROM user_activity_event
                         WHERE created_at < ${queryCutoff} AND query_norm IS NOT NULL
                         ORDER BY created_at LIMIT ${batchSize})
        `)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );

  const authCutoff = before(AUTH_EVENT_RETENTION_DAYS);
  const authEventsDeleted = await inBatches(
    async () =>
      (
        await db.execute(sql`
          DELETE FROM auth_event
           WHERE id IN (SELECT id FROM auth_event
                         WHERE created_at < ${authCutoff}
                         ORDER BY created_at LIMIT ${batchSize})
        `)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );

  const ipCutoff = before(CONSENT_IP_RETENTION_DAYS);
  const consentIpsCleared = await inBatches(
    async () =>
      (
        await db.execute(sql`
          UPDATE user_consent SET ip = NULL
           WHERE id IN (SELECT id FROM user_consent
                         WHERE ip IS NOT NULL AND granted_at < ${ipCutoff}
                         LIMIT ${batchSize})
        `)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );

  return { activityEventsDeleted, queryNormsCleared, authEventsDeleted, consentIpsCleared };
}
