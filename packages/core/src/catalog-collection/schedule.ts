/**
 * Zamanlanmis yonetici tarayicisi toplamasi: sunucu tarafi (karar 0221 §B, 0118'i degistirir).
 *
 * Sunucu kaynaga istek ATMAZ. Yalniz (1) kaynak basina hedef listesini ve hizi saklar,
 * (2) "simdi koşu baslatilabilir mi" sorusunu kota durumundan (`getCollectionStatus`)
 * yanitlar, (3) zamanlanmis koşuyu `collection_run` satiri olarak acar ve (4) sonucu kaydeder.
 * Kota (en az 7 gun, ayda 4, ilk yukleme dahil) veritabani tetikleyicisinde zorunludur; burasi
 * onu gevsetemez.
 *
 * Kaynaktan bagimsizdir; hedef adres dogrulayicisi kaynak basinadir (`TARGET_VALIDATORS`).
 * Dogrulayicisi olmayan kaynak zamanlanamaz.
 */
import { collectionRun, collectionSchedule, type Database } from "@arilla/db";
import { eq } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import {
  isFailedOutcome,
  MAX_PACE_SECONDS,
  MIN_PACE_SECONDS,
  normalizeScheduleTargets,
  type ScheduleDecision,
  type ScheduleOutcome,
  scheduleDecision,
} from "./schedule-logic.ts";
import {
  type CatalogCollectionStatus,
  CollectionError,
  collectionErrorFrom,
  getCollectionStatus,
  isSourceFlagEnabled,
  type RunView,
} from "./service.ts";
import { isCollectibleTrendyolUrl } from "./trendyol-relay.ts";

/** Kaynak basina zamanlanabilir hedef adres kurali. */
const TARGET_VALIDATORS: Record<string, (url: string) => boolean> = {
  trendyol: isCollectibleTrendyolUrl,
};

const OUTCOMES: readonly ScheduleOutcome[] = [
  "completed",
  "aborted",
  "blocked",
  "budget",
  "interrupted",
  "start_refused",
  "error",
];
const ERROR_CODE = /^[a-z0-9_]{2,60}$/;

/**
 * Zamanlayici ortam bayragi: `<KAYNAK>_SCHEDULE_ENABLED=true` VE kaynagin kendi bayragi
 * (Trendyol: `TRENDYOL_COLLECTION_ENABLED`). Varsayilan KAPALI.
 */
export function isScheduleFlagEnabled(
  source: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!(source in TARGET_VALIDATORS)) return false;
  const key = `${source.toUpperCase()}_SCHEDULE_ENABLED`;
  return env[key]?.trim().toLowerCase() === "true" && isSourceFlagEnabled(source, env);
}

export interface ScheduleView {
  source: string;
  flagEnabled: boolean;
  enabled: boolean;
  targetUrls: string[];
  paceSeconds: number;
  updatedAt: Date | null;
  lastAttemptAt: Date | null;
  lastRunId: number | null;
  lastOutcome: ScheduleOutcome | null;
  lastErrorCode: string | null;
  lastFinishedAt: Date | null;
  lastFailed: boolean;
  decision: ScheduleDecision;
}

type ScheduleRow = typeof collectionSchedule.$inferSelect;

function assertSchedulable(source: unknown): asserts source is string {
  if (typeof source !== "string" || !(source in TARGET_VALIDATORS)) {
    throw new CollectionError("unknown_source");
  }
  // Kaynak bayragi kapaliyken varligi sezdirilmez (sayfa/API 404, karar 0118).
  if (!isSourceFlagEnabled(source)) throw new CollectionError("unknown_source");
}

async function readSchedule(db: Database, source: string): Promise<ScheduleRow | null> {
  const [row] = await db
    .select()
    .from(collectionSchedule)
    .where(eq(collectionSchedule.source, source));
  return row ?? null;
}

function toView(
  source: string,
  row: ScheduleRow | null,
  status: CatalogCollectionStatus,
  openRunScheduled: boolean,
  now: Date,
  env: Readonly<Record<string, string | undefined>>,
): ScheduleView {
  const flagEnabled = isScheduleFlagEnabled(source, env);
  const targetUrls = Array.isArray(row?.targetUrls) ? row.targetUrls : [];
  const lastOutcome = row?.lastOutcome ?? null;
  return {
    source,
    flagEnabled,
    enabled: row?.enabled ?? false,
    targetUrls,
    paceSeconds: row?.paceSeconds ?? 45,
    updatedAt: row?.updatedAt ?? null,
    lastAttemptAt: row?.lastAttemptAt ?? null,
    lastRunId: row?.lastRunId ?? null,
    lastOutcome,
    lastErrorCode: row?.lastErrorCode ?? null,
    lastFinishedAt: row?.lastFinishedAt ?? null,
    lastFailed: isFailedOutcome(lastOutcome),
    decision: scheduleDecision(
      {
        flagEnabled,
        scheduleEnabled: row?.enabled ?? false,
        sourceEnabled: status.quota.enabled,
        targetCount: targetUrls.length,
        quota: {
          canStart: status.quota.canStart,
          blockedBy: status.quota.blockedBy,
          nextAllowedAt: status.quota.nextAllowedAt,
        },
        openRun: status.openRun ? { id: status.openRun.id, scheduled: openRunScheduled } : null,
      },
      now,
    ),
  };
}

async function openRunIsScheduled(db: Database, status: CatalogCollectionStatus) {
  if (!status.openRun) return false;
  const [run] = await db
    .select({ options: collectionRun.options })
    .from(collectionRun)
    .where(eq(collectionRun.id, status.openRun.id));
  return (run?.options as Record<string, unknown> | undefined)?.trigger === "scheduled";
}

/** Yonetim sayfasi ve eklentinin yokladigi durum. Yazmaz (suresi dolmus kosuyu kapatmak disinda). */
export async function getCollectionSchedule(
  db: Database,
  actor: AdminActor,
  source: string,
  now: Date = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ schedule: ScheduleView; status: CatalogCollectionStatus }> {
  assertCapability(actor, "catalog.write");
  assertSchedulable(source);
  const status = await getCollectionStatus(db, actor, source, now);
  const row = await readSchedule(db, source);
  const scheduled = await openRunIsScheduled(db, status);
  return { schedule: toView(source, row, status, scheduled, now, env), status };
}

export interface SaveScheduleInput {
  source: string;
  enabled: boolean;
  targetUrls: unknown;
  paceSeconds: number;
}

/** Hedef listesi / hiz / acik-kapali. Acmak ortam bayragi ister; kota DEGISMEZ. */
export async function saveCollectionSchedule(
  db: Database,
  actor: AdminActor,
  input: SaveScheduleInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ saved: number; invalid: number; overflow: number }> {
  assertCapability(actor, "catalog.write");
  assertSchedulable(input.source);
  const validator = TARGET_VALIDATORS[input.source] as (url: string) => boolean;
  const { urls, invalid, overflow } = normalizeScheduleTargets(input.targetUrls, validator);
  const pace = Number(input.paceSeconds);
  if (!(Number.isInteger(pace) && pace >= MIN_PACE_SECONDS && pace <= MAX_PACE_SECONDS)) {
    throw new CollectionError("bad_pace");
  }
  const enabled = input.enabled === true;
  if (enabled && !isScheduleFlagEnabled(input.source, env)) {
    throw new CollectionError("schedule_flag_off");
  }
  if (enabled && urls.length === 0) throw new CollectionError("no_targets");
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(collectionSchedule)
      .where(eq(collectionSchedule.source, input.source))
      .for("update");
    const values = {
      enabled,
      targetUrls: urls,
      paceSeconds: pace,
      updatedBy: actor.userId,
      updatedAt: new Date(),
    };
    await tx
      .insert(collectionSchedule)
      .values({ source: input.source, ...values })
      .onConflictDoUpdate({ target: collectionSchedule.source, set: values });
    await recordAdminEvent(tx, {
      actor,
      action: "catalog_collection.schedule_update",
      targetType: "collection_run",
      targetId: "-",
      before: before
        ? {
            source: input.source,
            enabled: before.enabled,
            targets: Array.isArray(before.targetUrls) ? before.targetUrls.length : 0,
            paceSeconds: before.paceSeconds,
          }
        : null,
      after: { source: input.source, enabled, targets: urls.length, paceSeconds: pace },
    });
  });
  return { saved: urls.length, invalid, overflow };
}

async function recordOutcome(
  db: Database,
  source: string,
  values: Partial<typeof collectionSchedule.$inferInsert>,
): Promise<void> {
  await db.update(collectionSchedule).set(values).where(eq(collectionSchedule.source, source));
}

/**
 * Zamanlanmis koşuyu acar. Karar `start` degilse acmaz (`schedule_<neden>` kodu). Kota
 * tetikleyicisi yine son karardir; reddederse sonuc `start_refused` olarak kaydedilir.
 *
 * Taze giris ISTEMEZ (otomatik): hedef listesi ve acma karari daha once taze girisle
 * kaydedilmis zamanlamadan gelir; istemci hedef/kota parametresi veremez.
 */
export async function startScheduledRun(
  db: Database,
  actor: AdminActor,
  source: string,
  now: Date = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ run: RunView; targetUrls: string[]; paceSeconds: number }> {
  const { schedule } = await getCollectionSchedule(db, actor, source, now, env);
  if (schedule.decision.action !== "start") {
    const reason =
      schedule.decision.action === "wait" ? schedule.decision.reason : "interrupted_run_open";
    throw new CollectionError(`schedule_${reason}`);
  }
  await recordOutcome(db, source, {
    lastAttemptAt: now,
    lastOutcome: null,
    lastErrorCode: null,
    lastFinishedAt: null,
  });
  try {
    const run = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(collectionRun)
        .values({
          source,
          startedBy: actor.userId,
          // Tetikleyici bu ikisini politikadan yeniden yazar.
          expiresAt: new Date(),
          maxRequests: 1,
          options: { trigger: "scheduled", targets: schedule.targetUrls.length },
        })
        .returning();
      if (!row) throw new CollectionError("insert_failed");
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_collection.scheduled_start",
        targetType: "collection_run",
        targetId: row.id,
        before: null,
        after: { source, maxRequests: row.maxRequests, targets: schedule.targetUrls.length },
      });
      return row;
    });
    await recordOutcome(db, source, { lastRunId: run.id });
    const view: RunView = {
      id: run.id,
      kind: run.kind,
      status: run.status,
      reservedAt: run.reservedAt,
      expiresAt: run.expiresAt,
      closedAt: run.closedAt,
      requestsMade: run.requestsMade,
      requestsReserved: run.requestsReserved,
      productsCounted: run.productsCounted,
      maxRequests: run.maxRequests,
      maxBytes: run.maxBytes,
      bytesDownloaded: run.bytesDownloaded,
      downloadApprovedBytes: run.downloadApprovedBytes,
      checkpoint: run.checkpoint,
      summary: run.summary,
    };
    return {
      run: view,
      targetUrls: schedule.targetUrls.slice(0, run.maxRequests),
      paceSeconds: schedule.paceSeconds,
    };
  } catch (error) {
    const mapped = collectionErrorFrom(error) ?? new CollectionError("start_failed");
    await recordOutcome(db, source, {
      lastOutcome: "start_refused",
      lastErrorCode: ERROR_CODE.test(mapped.code) ? mapped.code : "start_failed",
      lastFinishedAt: now,
    });
    throw mapped;
  }
}

/** Zamanlanmis kosunun sonucu (tarayici bildirir). Yalniz zamanlamanin son koşusu icin. */
export async function recordScheduledOutcome(
  db: Database,
  actor: AdminActor,
  input: { source: string; runId: number; outcome: string; errorCode?: string | null },
  now: Date = new Date(),
): Promise<void> {
  assertCapability(actor, "catalog.write");
  assertSchedulable(input.source);
  if (!OUTCOMES.includes(input.outcome as ScheduleOutcome) || input.outcome === "start_refused") {
    throw new CollectionError("bad_outcome");
  }
  const errorCode =
    typeof input.errorCode === "string" && ERROR_CODE.test(input.errorCode)
      ? input.errorCode
      : null;
  const [run] = await db
    .select({ options: collectionRun.options, source: collectionRun.source })
    .from(collectionRun)
    .where(eq(collectionRun.id, input.runId));
  if (
    run?.source !== input.source ||
    (run.options as Record<string, unknown>)?.trigger !== "scheduled"
  ) {
    throw new CollectionError("not_scheduled_run");
  }
  await db.transaction(async (tx) => {
    await tx
      .update(collectionSchedule)
      .set({
        lastRunId: input.runId,
        lastOutcome: input.outcome as ScheduleOutcome,
        lastErrorCode: errorCode,
        lastFinishedAt: now,
      })
      .where(eq(collectionSchedule.source, input.source));
    await recordAdminEvent(tx, {
      actor,
      action: "catalog_collection.scheduled_outcome",
      targetType: "collection_run",
      targetId: input.runId,
      before: null,
      after: { source: input.source, outcome: input.outcome, errorCode },
    });
  });
}
