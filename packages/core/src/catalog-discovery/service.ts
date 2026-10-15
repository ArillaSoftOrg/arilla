/**
 * Sitemap ile urun kesfi - sunucu tarafi (karar 0120).
 *
 * Akis: yonetici tarayicisi her kaynak isteginden ONCE buradan hak alir (`claim`). Sunucu
 * istek araligini, gunluk tavani, operasyon istek/bayt butcesini ve istemci kirasini zorlar;
 * istek defterine (`catalog_sync_request`) yazar. Tarayici dosyayi akisla ayristirir ve
 * kayitlari partiler halinde gonderir; sunucu her kaydi yeniden dogrular ve
 * `catalog_discovery`e birincil anahtarla upsert eder (tekrar kayit olusmaz).
 *
 * Operasyon turleri:
 *  - initial_import: haftalik kota hakki harcamaz (collection_run yazmaz).
 *  - weekly_refresh: operasyon basina TEK collection_run rezerve eder; 0070 tetikleyicisi
 *    >= 7 gun / ayda <= 4 kuralini zorlar. Her dosya ayri hak sayilmaz.
 *
 * TS offer/product/price_point YAZMAZ. Yayinlama, fiyat baglama ve kaldirilma degerlendirmesi
 * Python toplu islerindedir (`feeds discovery-publish`, `discovery-finalize`, `hb-merge`).
 */
import {
  catalogDiscoveryTally,
  catalogSyncOperation,
  catalogSyncRequest,
  catalogSyncUnit,
  collectionRun,
  type Database,
  discoverySourcePolicy,
} from "@arilla/db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import {
  getCollectionStatus,
  type QuotaState,
  type RunView,
} from "../catalog-collection/service.ts";
import { type DiscoveryRejection, dedupeItems, validateDiscoveryItem } from "./items.ts";

export const MAX_ITEMS_PER_BATCH = 2000;
export const MAX_PLAN_FILES_PER_CALL = 2500;
/** Bir operasyonun planlayabilecegi en fazla dosya (bozuk indekse karsi sinir). */
export const MAX_FILES_PER_OPERATION = 20_000;
/** Tek dosyanin acilmis govdesi icin ust sinir (olcum: 9-12 MB). */
export const FILE_MAX_DECODED_BYTES = 64 * 1024 * 1024;
/** Istemci kirasinin gecerlilik suresi: bu sureden eski sinyal "calisan istemci yok" demektir. */
export const LEASE_TTL_MS = 2 * 60_000;

export class DiscoveryError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(code: string, detail?: string) {
    super(code);
    this.name = "DiscoveryError";
    this.code = code;
    this.detail = detail;
  }
}

const TRIGGER_CODES =
  /(discovery_(?:disabled|initial_required|quota_run_invalid|operation_immutable|counter_decrease|operation_closed)|collection_(?:source_unknown|disabled|quota_interval|quota_month))/;
const UNIQUE_CODES: [RegExp, string][] = [
  [/catalog_sync_operation_one_active_uniq/, "discovery_operation_active"],
  [/catalog_sync_operation_one_initial_uniq/, "discovery_initial_exists"],
  [/collection_run_one_open_uniq/, "collection_run_already_open"],
];

/** Tetikleyici ve benzersizlik hatalarini bilinen kodlara cevirir (surucu hatayi sarmalar). */
export function discoveryErrorFrom(error: unknown): DiscoveryError | null {
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    const e = current as { message?: unknown; detail?: unknown; cause?: unknown };
    if (typeof e.message === "string") {
      const m = TRIGGER_CODES.exec(e.message);
      if (m) {
        return new DiscoveryError(
          m[1] as string,
          typeof e.detail === "string" ? e.detail : undefined,
        );
      }
      for (const [re, code] of UNIQUE_CODES) {
        if (re.test(e.message)) return new DiscoveryError(code);
      }
    }
    current = e.cause;
  }
  return null;
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    const mapped = discoveryErrorFrom(error);
    if (mapped) throw mapped;
    throw error;
  }
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ERROR_CODE = /^[a-z0-9_]{2,60}$/;

function assertClient(clientId: unknown): asserts clientId is string {
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
    throw new DiscoveryError("bad_client");
  }
}

function assertId(value: unknown, code = "bad_operation"): asserts value is number {
  if (!(Number.isSafeInteger(value) && (value as number) > 0)) throw new DiscoveryError(code);
}

function nonNegative(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function cleanDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: denetim karakterleri ayiklanir
  const t = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t ? t.slice(0, 300) : null;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;
type OperationRow = typeof catalogSyncOperation.$inferSelect;
type PolicyRow = typeof discoverySourcePolicy.$inferSelect;

async function loadPolicy(db: Executor, source: string): Promise<PolicyRow> {
  if (typeof source !== "string" || !/^[a-z0-9_]{2,40}$/.test(source)) {
    throw new DiscoveryError("unknown_source");
  }
  const [policy] = await db
    .select()
    .from(discoverySourcePolicy)
    .where(eq(discoverySourcePolicy.source, source));
  if (!policy) throw new DiscoveryError("unknown_source");
  return policy;
}

async function lockOperation(tx: Tx, operationId: number): Promise<OperationRow> {
  const [op] = await tx
    .select()
    .from(catalogSyncOperation)
    .where(eq(catalogSyncOperation.id, operationId))
    .for("update");
  if (!op) throw new DiscoveryError("operation_not_found");
  return op;
}

const ACTIVE: readonly string[] = ["open", "paused", "blocked"];

function leaseFresh(op: OperationRow, now: Date): boolean {
  return (
    op.leaseClient !== null &&
    op.leaseHeartbeatAt !== null &&
    now.getTime() - op.leaseHeartbeatAt.getTime() < LEASE_TTL_MS
  );
}

/** Istemci yazabilmek icin kirayi tutmali; kira suresi dolduysa yalnizca ACIK devralma (resume). */
function assertLease(op: OperationRow, clientId: string): void {
  if (op.leaseClient !== clientId) throw new DiscoveryError("lease_not_held");
}

/** Haftalik yenilemenin kota penceresi dolduysa (ya da kota satiri kapandiysa) operasyon biter. */
async function expireIfNeeded(tx: Tx, op: OperationRow, now: Date): Promise<OperationRow> {
  if (op.kind !== "weekly_refresh" || !ACTIVE.includes(op.status)) return op;
  const [run] = op.quotaRunId
    ? await tx.select().from(collectionRun).where(eq(collectionRun.id, op.quotaRunId)).for("update")
    : [];
  const expired =
    (op.expiresAt !== null && now.getTime() >= op.expiresAt.getTime()) || run?.status !== "open";
  if (!expired) return op;
  const [updated] = await tx
    .update(catalogSyncOperation)
    .set({
      status: "expired",
      removalState: "skipped_partial",
      leaseClient: null,
      leaseHeartbeatAt: null,
      lastErrorCode: "quota_window_expired",
      lastErrorDetail: "Haftalık yenilemenin kota penceresi doldu; yarım tarama kaldırma sayılmaz.",
    })
    .where(eq(catalogSyncOperation.id, op.id))
    .returning();
  if (run?.status === "open") {
    await tx
      .update(collectionRun)
      .set({
        status: "aborted",
        summary: { reason: "expired", mode: "sitemap_refresh", operationId: op.id },
      })
      .where(eq(collectionRun.id, run.id));
  }
  return updated ?? op;
}

/**
 * Sure dolumunu AYRI islemde kalici yapar: ardindan gelen islem hata firlatsa da (operasyon
 * kapali) kapanis geri alinmaz.
 */
async function settleExpiry(db: Database, operationId: number, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await expireIfNeeded(tx, await lockOperation(tx, operationId), now);
  });
}

// ---------------------------------------------------------------------------
// Durum
// ---------------------------------------------------------------------------

export interface DiscoveryOperationView {
  id: number;
  kind: "initial_import" | "weekly_refresh";
  status: string;
  quotaRunId: number | null;
  networkDeclared: string;
  requestsMade: number;
  maxRequests: number;
  bytesDecoded: number;
  bytesTransferred: number;
  maxBytes: number;
  filesPlanned: number;
  createdAt: Date;
  expiresAt: Date | null;
  lastRequestAt: Date | null;
  lastCheckpointAt: Date | null;
  lastSuccessAt: Date | null;
  blockedAt: Date | null;
  closedAt: Date | null;
  leaseClient: string | null;
  leaseHeartbeatAt: Date | null;
  /** Kira taze mi: yalnizca o zaman "bir istemci calisiyor" denir. */
  clientActive: boolean;
  removalState: string;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  summary: Record<string, unknown> | null;
}

export interface UnitCounts {
  pending: number;
  fetching: number;
  done: number;
  failed: number;
  blocked: number;
  /** Deneme hakki biten basarisiz dosyalar. */
  failedFinal: number;
  itemsFound: number;
  itemsNew: number;
}

export interface DiscoveryTally {
  itemsTotal: number;
  itemsPriced: number;
  itemsUnpriced: number;
  itemsPublished: number;
  itemsRemoved: number;
  recountedAt: Date | null;
}

export interface CatalogDiscoveryStatus {
  source: string;
  policy: {
    enabled: boolean;
    indexUrl: string;
    minRequestIntervalMs: number;
    dailyMaxRequests: number;
    initialMaxRequests: number;
    initialMaxBytes: number;
    refreshMaxRequests: number;
    refreshMaxBytes: number;
    maxAttemptsPerFile: number;
    blockedCooldownHours: number;
    removalMissedScans: number;
    targetUniqueItems: number;
  };
  tally: DiscoveryTally;
  requestsLast24h: number;
  active: DiscoveryOperationView | null;
  activeUnits: UnitCounts | null;
  recent: DiscoveryOperationView[];
  initialImport: DiscoveryOperationView | null;
  /** Haftalik yenileme kotasi (0070 defteri; ilk aktarim buraya SAYILMAZ). */
  refreshQuota: QuotaState;
  /** Kota defterinin acik LISTE TOPLAYICI kosusu (sitemap yenilemesi degil); surdurulebilir. */
  openListingRun: RunView | null;
  /** Kota defteri gecmisi (kosu #1 dahil, degistirilmeden). */
  recentRuns: RunView[];
  canStartInitial: boolean;
  canStartRefresh: boolean;
  startBlockedReason: string | null;
  /** Engel sonrasi en erken surdurme zamani. */
  resumeAllowedAt: Date | null;
}

function toView(op: OperationRow, now: Date): DiscoveryOperationView {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    quotaRunId: op.quotaRunId,
    networkDeclared: op.networkDeclared,
    requestsMade: op.requestsMade,
    maxRequests: op.maxRequests,
    bytesDecoded: op.bytesDecoded,
    bytesTransferred: op.bytesTransferred,
    maxBytes: op.maxBytes,
    filesPlanned: op.filesPlanned,
    createdAt: op.createdAt,
    expiresAt: op.expiresAt,
    lastRequestAt: op.lastRequestAt,
    lastCheckpointAt: op.lastCheckpointAt,
    lastSuccessAt: op.lastSuccessAt,
    blockedAt: op.blockedAt,
    closedAt: op.closedAt,
    leaseClient: op.leaseClient,
    leaseHeartbeatAt: op.leaseHeartbeatAt,
    clientActive: ACTIVE.includes(op.status) && leaseFresh(op, now),
    removalState: op.removalState,
    lastErrorCode: op.lastErrorCode,
    lastErrorDetail: op.lastErrorDetail,
    summary: op.summary,
  };
}

async function unitCounts(
  db: Executor,
  operationId: number,
  maxAttempts: number,
): Promise<UnitCounts> {
  const result = await db.execute<Record<string, string | null>>(sql`
    SELECT count(*) FILTER (WHERE status = 'pending')  AS pending,
           count(*) FILTER (WHERE status = 'fetching') AS fetching,
           count(*) FILTER (WHERE status = 'done')     AS done,
           count(*) FILTER (WHERE status = 'failed')   AS failed,
           count(*) FILTER (WHERE status = 'blocked')  AS blocked,
           count(*) FILTER (WHERE status = 'failed' AND attempts >= ${maxAttempts}) AS failed_final,
           coalesce(sum(items_found), 0) AS items_found,
           coalesce(sum(items_new), 0)   AS items_new
      FROM catalog_sync_unit
     WHERE operation_id = ${operationId} AND unit_kind = 'file'
  `);
  const r = result.rows[0] ?? {};
  const n = (v: string | null | undefined) => Number(v ?? 0);
  return {
    pending: n(r.pending),
    fetching: n(r.fetching),
    done: n(r.done),
    failed: n(r.failed),
    blocked: n(r.blocked),
    failedFinal: n(r.failed_final),
    itemsFound: n(r.items_found),
    itemsNew: n(r.items_new),
  };
}

async function requestsLast24h(db: Executor, source: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(catalogSyncRequest)
    .where(and(eq(catalogSyncRequest.source, source), gt(catalogSyncRequest.requestedAt, since)));
  return row?.n ?? 0;
}

export async function getDiscoveryStatus(
  db: Database,
  actor: AdminActor,
  source: string,
  now: Date = new Date(),
): Promise<CatalogDiscoveryStatus> {
  assertCapability(actor, "catalog.write");
  const policy = await loadPolicy(db, source);
  // Haftalik kota durumu (suresi dolmus kosulari da kapatir).
  const quotaStatus = await getCollectionStatus(db, actor, source, now);

  const ops = await db
    .select()
    .from(catalogSyncOperation)
    .where(eq(catalogSyncOperation.source, source))
    .orderBy(desc(catalogSyncOperation.createdAt))
    .limit(10);
  let active = ops.find((o) => ACTIVE.includes(o.status)) ?? null;
  if (active?.kind === "weekly_refresh") {
    const current = active;
    active = await db.transaction(async (tx) =>
      expireIfNeeded(tx, await lockOperation(tx, current.id), now),
    );
    if (!ACTIVE.includes(active.status)) active = null;
  }
  const [tallyRow] = await db
    .select()
    .from(catalogDiscoveryTally)
    .where(eq(catalogDiscoveryTally.source, source));
  const initial =
    ops.find((o) => o.kind === "initial_import" && o.status !== "cancelled") ??
    (
      await db
        .select()
        .from(catalogSyncOperation)
        .where(
          and(
            eq(catalogSyncOperation.source, source),
            eq(catalogSyncOperation.kind, "initial_import"),
            sql`${catalogSyncOperation.status} <> 'cancelled'`,
          ),
        )
        .limit(1)
    )[0] ??
    null;

  const quota = quotaStatus.quota;
  let startBlockedReason: string | null = null;
  if (!policy.enabled) startBlockedReason = "disabled";
  else if (active) startBlockedReason = "active_operation";
  const canStartInitial = startBlockedReason === null && initial === null;
  let canStartRefresh = startBlockedReason === null && initial?.status === "completed";
  if (canStartRefresh && !quota.canStart) canStartRefresh = false;

  const total = tallyRow?.itemsTotal ?? 0;
  const priced = Math.min(tallyRow?.itemsPriced ?? 0, total);
  return {
    source,
    policy: {
      enabled: policy.enabled,
      indexUrl: policy.indexUrl,
      minRequestIntervalMs: policy.minRequestIntervalMs,
      dailyMaxRequests: policy.dailyMaxRequests,
      initialMaxRequests: policy.initialMaxRequests,
      initialMaxBytes: policy.initialMaxBytes,
      refreshMaxRequests: policy.refreshMaxRequests,
      refreshMaxBytes: policy.refreshMaxBytes,
      maxAttemptsPerFile: policy.maxAttemptsPerFile,
      blockedCooldownHours: policy.blockedCooldownHours,
      removalMissedScans: policy.removalMissedScans,
      targetUniqueItems: policy.targetUniqueItems,
    },
    tally: {
      itemsTotal: total,
      itemsPriced: priced,
      itemsUnpriced: total - priced,
      itemsPublished: tallyRow?.itemsPublished ?? 0,
      itemsRemoved: tallyRow?.itemsRemoved ?? 0,
      recountedAt: tallyRow?.recountedAt ?? null,
    },
    requestsLast24h: await requestsLast24h(db, source, now),
    active: active ? toView(active, now) : null,
    activeUnits: active ? await unitCounts(db, active.id, policy.maxAttemptsPerFile) : null,
    recent: ops.map((o) => toView(o, now)),
    initialImport: initial ? toView(initial, now) : null,
    refreshQuota: quota,
    openListingRun:
      quotaStatus.openRun && quotaStatus.openRun.options?.mode !== "sitemap_refresh"
        ? quotaStatus.openRun
        : null,
    recentRuns: quotaStatus.recentRuns,
    canStartInitial,
    canStartRefresh,
    startBlockedReason,
    resumeAllowedAt:
      active?.status === "blocked" && active.blockedAt
        ? new Date(active.blockedAt.getTime() + policy.blockedCooldownHours * 3_600_000)
        : null,
  };
}

export interface FailedUnitView {
  seq: number;
  fileUrl: string;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorDetail: string | null;
  claimedAt: Date | null;
}

/** Hatali/engelli dosyalarin ayrintisi (panel). */
export async function listProblemUnits(
  db: Database,
  actor: AdminActor,
  operationId: number,
  limit = 50,
): Promise<FailedUnitView[]> {
  assertCapability(actor, "catalog.write");
  assertId(operationId);
  const rows = await db
    .select()
    .from(catalogSyncUnit)
    .where(
      and(
        eq(catalogSyncUnit.operationId, operationId),
        inArray(catalogSyncUnit.status, ["failed", "blocked"]),
      ),
    )
    .orderBy(asc(catalogSyncUnit.seq))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((u) => ({
    seq: u.seq,
    fileUrl: u.fileUrl,
    status: u.status,
    attempts: u.attempts,
    errorCode: u.errorCode,
    errorDetail: u.errorDetail,
    claimedAt: u.claimedAt,
  }));
}

// ---------------------------------------------------------------------------
// Baslatma
// ---------------------------------------------------------------------------

export interface StartOperationInput {
  source: string;
  kind: "initial_import" | "weekly_refresh";
  network: "wifi" | "wired";
  clientId: string;
}

export async function startDiscoveryOperation(
  db: Database,
  actor: AdminActor,
  input: StartOperationInput,
  now: Date = new Date(),
): Promise<DiscoveryOperationView> {
  assertCapability(actor, "catalog.write");
  if (input.kind !== "initial_import" && input.kind !== "weekly_refresh") {
    throw new DiscoveryError("bad_kind");
  }
  // Buyuk aktarim mobil veriyle baslatilmaz: yonetici Wi-Fi ya da kablolu ag beyan etmeli.
  if (input.network !== "wifi" && input.network !== "wired") {
    throw new DiscoveryError("network_not_declared");
  }
  assertClient(input.clientId);
  const policy = await loadPolicy(db, input.source);
  if (!policy.enabled) throw new DiscoveryError("discovery_disabled");
  // Haftalik kota satirlarinin suresi dolduysa once kapanir (0070 ile ayni davranis).
  if (input.kind === "weekly_refresh") await getCollectionStatus(db, actor, input.source, now);

  return mapErrors(() =>
    db.transaction(async (tx) => {
      let quotaRunId: number | null = null;
      if (input.kind === "weekly_refresh") {
        const [run] = await tx
          .insert(collectionRun)
          .values({
            source: input.source,
            startedBy: actor.userId,
            // Tetikleyici politikadan yeniden yazar.
            expiresAt: now,
            maxRequests: 1,
            options: { mode: "sitemap_refresh" },
          })
          .returning();
        if (!run) throw new DiscoveryError("insert_failed");
        if (run.kind !== "refresh") {
          // Kota defterinde hic kosu yokken yenileme baslatilamaz (ilk kosu 'initial' sayilir).
          throw new DiscoveryError("discovery_quota_run_invalid");
        }
        quotaRunId = run.id;
      }
      const [op] = await tx
        .insert(catalogSyncOperation)
        .values({
          source: input.source,
          kind: input.kind,
          quotaRunId,
          startedBy: actor.userId,
          networkDeclared: input.network,
          // Tetikleyici politikadan yeniden yazar.
          maxRequests: 1,
          maxBytes: 1,
          leaseClient: input.clientId,
          leaseHeartbeatAt: now,
        })
        .returning();
      if (!op) throw new DiscoveryError("insert_failed");
      await tx.insert(catalogSyncUnit).values({
        operationId: op.id,
        seq: 0,
        unitKind: "index",
        fileUrl: policy.indexUrl,
      });
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_discovery.start",
        targetType: "catalog_sync_operation",
        targetId: op.id,
        before: null,
        after: {
          source: input.source,
          kind: input.kind,
          network: input.network,
          maxRequests: op.maxRequests,
          maxBytes: op.maxBytes,
          quotaRunId,
        },
      });
      return toView(op, now);
    }),
  );
}

// ---------------------------------------------------------------------------
// Hak alma (her kaynak isteginden once)
// ---------------------------------------------------------------------------

export type ClaimResult =
  | {
      kind: "unit";
      seq: number;
      unitKind: "index" | "file";
      url: string;
      attempt: number;
      maxDecodedBytes: number;
    }
  | { kind: "wait"; waitMs: number; reason: "interval" | "daily_limit" }
  | { kind: "done"; status: string };

async function closeOperation(tx: Tx, op: OperationRow, policy: PolicyRow): Promise<OperationRow> {
  const counts = await unitCounts(tx, op.id, policy.maxAttemptsPerFile);
  const complete = counts.failed === 0 && counts.blocked === 0 && counts.pending === 0;
  const summary = {
    filesPlanned: op.filesPlanned,
    filesDone: counts.done,
    filesFailed: counts.failed,
    itemsFound: counts.itemsFound,
    itemsNew: counts.itemsNew,
    complete,
  };
  const [closed] = await tx
    .update(catalogSyncOperation)
    .set({
      status: "completed",
      removalState:
        op.kind === "weekly_refresh"
          ? complete
            ? "pending"
            : "skipped_partial"
          : "not_applicable",
      leaseClient: null,
      leaseHeartbeatAt: null,
      summary,
    })
    .where(eq(catalogSyncOperation.id, op.id))
    .returning();
  if (op.quotaRunId) {
    await tx
      .update(collectionRun)
      .set({
        status: "completed",
        summary: {
          mode: "sitemap_refresh",
          operationId: op.id,
          requests: op.requestsMade,
          ...summary,
        },
      })
      .where(and(eq(collectionRun.id, op.quotaRunId), eq(collectionRun.status, "open")));
  }
  return closed ?? op;
}

export async function claimDiscoveryUnit(
  db: Database,
  actor: AdminActor,
  input: { operationId: number; clientId: string },
  now: Date = new Date(),
): Promise<ClaimResult> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  assertClient(input.clientId);
  await mapErrors(() => settleExpiry(db, input.operationId, now));
  return mapErrors(() =>
    db.transaction(async (tx) => {
      let op = await lockOperation(tx, input.operationId);
      const policy = await loadPolicy(tx, op.source);
      if (!policy.enabled) throw new DiscoveryError("discovery_disabled");
      op = await expireIfNeeded(tx, op, now);
      if (op.status === "paused") throw new DiscoveryError("operation_paused");
      if (op.status === "blocked") throw new DiscoveryError("operation_blocked");
      if (op.status !== "open") throw new DiscoveryError("operation_closed", op.status);
      assertLease(op, input.clientId);

      // Sonucu hic bildirilmemis hak (tarayici kapandi): deneme sayilir, yeniden denenebilir.
      await tx
        .update(catalogSyncUnit)
        .set({
          status: "failed",
          errorCode: "interrupted",
          errorDetail: "Sonuç bildirilmeden kesildi.",
        })
        .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.status, "fetching")));

      // Siradaki birim: once indeks, sonra bekleyen dosyalar, en son deneme hakki kalan hatalilar.
      const [next] = await tx
        .select()
        .from(catalogSyncUnit)
        .where(
          and(
            eq(catalogSyncUnit.operationId, op.id),
            sql`(${catalogSyncUnit.status} = 'pending'
                 OR (${catalogSyncUnit.status} = 'failed'
                     AND ${catalogSyncUnit.attempts} < ${policy.maxAttemptsPerFile}))`,
          ),
        )
        .orderBy(
          sql`CASE WHEN ${catalogSyncUnit.unitKind} = 'index' THEN 0
                   WHEN ${catalogSyncUnit.status} = 'pending' THEN 1 ELSE 2 END`,
          asc(catalogSyncUnit.seq),
        )
        .limit(1);

      if (!next) {
        const [index] = await tx
          .select()
          .from(catalogSyncUnit)
          .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.seq, 0)));
        if (index?.status !== "done") throw new DiscoveryError("index_failed");
        const closed = await closeOperation(tx, op, policy);
        return { kind: "done", status: closed.status } as const;
      }

      if (op.requestsMade >= op.maxRequests) throw new DiscoveryError("request_budget_exceeded");
      if (op.bytesDecoded >= op.maxBytes) throw new DiscoveryError("byte_budget_exceeded");

      // Istek araligi: kaynak basina son istekten bu yana (tum operasyonlar).
      const [last] = await tx
        .select({ at: catalogSyncRequest.requestedAt })
        .from(catalogSyncRequest)
        .where(eq(catalogSyncRequest.source, op.source))
        .orderBy(desc(catalogSyncRequest.requestedAt))
        .limit(1);
      if (last) {
        const waitMs = last.at.getTime() + policy.minRequestIntervalMs - now.getTime();
        if (waitMs > 0) {
          await touchLease(tx, op.id, now);
          return { kind: "wait", waitMs, reason: "interval" } as const;
        }
      }
      // Kayan 24 saat tavani.
      const since = new Date(now.getTime() - 86_400_000);
      const window = await tx
        .select({ at: catalogSyncRequest.requestedAt })
        .from(catalogSyncRequest)
        .where(
          and(eq(catalogSyncRequest.source, op.source), gt(catalogSyncRequest.requestedAt, since)),
        )
        .orderBy(asc(catalogSyncRequest.requestedAt))
        .limit(policy.dailyMaxRequests);
      if (window.length >= policy.dailyMaxRequests) {
        const oldest = window[0]?.at ?? now;
        await touchLease(tx, op.id, now);
        return {
          kind: "wait",
          waitMs: Math.max(1000, oldest.getTime() + 86_400_000 - now.getTime()),
          reason: "daily_limit",
        } as const;
      }

      await tx
        .update(catalogSyncUnit)
        .set({
          status: "fetching",
          attempts: next.attempts + 1,
          claimedAt: now,
          errorCode: null,
          errorDetail: null,
        })
        .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.seq, next.seq)));
      await tx.insert(catalogSyncRequest).values({
        source: op.source,
        operationId: op.id,
        seq: next.seq,
        requestedAt: now,
      });
      await tx
        .update(catalogSyncOperation)
        .set({
          requestsMade: op.requestsMade + 1,
          lastRequestAt: now,
          leaseHeartbeatAt: now,
        })
        .where(eq(catalogSyncOperation.id, op.id));
      return {
        kind: "unit",
        seq: next.seq,
        unitKind: next.unitKind,
        url: next.fileUrl,
        attempt: next.attempts + 1,
        maxDecodedBytes: Math.max(
          1,
          Math.min(FILE_MAX_DECODED_BYTES, op.maxBytes - op.bytesDecoded),
        ),
      } as const;
    }),
  );
}

async function touchLease(tx: Tx, operationId: number, now: Date): Promise<void> {
  await tx
    .update(catalogSyncOperation)
    .set({ leaseHeartbeatAt: now })
    .where(eq(catalogSyncOperation.id, operationId));
}

/** Yazim yapilabilir operasyon: acik ya da (yoldaki dosya bitsin diye) duraklatilmis + kira. */
async function writableOperation(
  tx: Tx,
  operationId: number,
  clientId: string,
): Promise<{ op: OperationRow; policy: PolicyRow }> {
  const op = await lockOperation(tx, operationId);
  if (op.status !== "open" && op.status !== "paused") {
    throw new DiscoveryError("operation_closed", op.status);
  }
  if (op.status === "open") assertLease(op, clientId);
  else if (op.leaseClient !== null && op.leaseClient !== clientId) {
    throw new DiscoveryError("lease_not_held");
  }
  const policy = await loadPolicy(tx, op.source);
  return { op, policy };
}

async function fetchingUnit(tx: Tx, operationId: number, seq: number) {
  const [unit] = await tx
    .select()
    .from(catalogSyncUnit)
    .where(and(eq(catalogSyncUnit.operationId, operationId), eq(catalogSyncUnit.seq, seq)))
    .for("update");
  if (!unit) throw new DiscoveryError("unit_not_found");
  if (unit.status !== "fetching") throw new DiscoveryError("unit_not_fetching", unit.status);
  return unit;
}

// ---------------------------------------------------------------------------
// Indeks plani
// ---------------------------------------------------------------------------

export interface PlanInput {
  operationId: number;
  clientId: string;
  files: { url: string; lastmod?: string | null }[];
  final: boolean;
  bytesDecoded?: number;
  bytesTransferred?: number;
}

export interface PlanResult {
  planned: number;
  duplicates: number;
  rejected: number;
  filesPlanned: number;
}

/** Indeksteki dosya adresi: indeksle ayni koken + politikadaki yol deseni; sorgu/parca yok. */
export function acceptFileUrl(raw: unknown, indexUrl: string, pathPattern: string): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    const index = new URL(indexUrl);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.host !== index.host ||
      u.search ||
      u.hash ||
      !new RegExp(pathPattern).test(u.pathname) ||
      u.toString() === index.toString()
    ) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

export async function submitDiscoveryPlan(
  db: Database,
  actor: AdminActor,
  input: PlanInput,
  now: Date = new Date(),
): Promise<PlanResult> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  assertClient(input.clientId);
  if (!Array.isArray(input.files) || input.files.length > MAX_PLAN_FILES_PER_CALL) {
    throw new DiscoveryError("batch_too_large");
  }
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const { op, policy } = await writableOperation(tx, input.operationId, input.clientId);
      const index = await fetchingUnit(tx, op.id, 0);
      const accepted: { url: string; lastmod: Date | null }[] = [];
      const seen = new Set<string>();
      let rejected = 0;
      let duplicates = 0;
      for (const f of input.files) {
        const url = acceptFileUrl(f?.url, policy.indexUrl, policy.filePathPattern);
        if (!url) {
          rejected += 1;
          continue;
        }
        if (seen.has(url)) {
          duplicates += 1;
          continue;
        }
        seen.add(url);
        const lm = typeof f.lastmod === "string" ? new Date(f.lastmod) : null;
        accepted.push({ url, lastmod: lm && !Number.isNaN(lm.getTime()) ? lm : null });
      }
      const [maxRow] = await tx
        .select({ max: sql<number>`coalesce(max(${catalogSyncUnit.seq}), 0)::int` })
        .from(catalogSyncUnit)
        .where(eq(catalogSyncUnit.operationId, op.id));
      let nextSeq = (maxRow?.max ?? 0) + 1;
      let planned = 0;
      if (accepted.length > 0) {
        if (op.filesPlanned + accepted.length > MAX_FILES_PER_OPERATION) {
          throw new DiscoveryError("too_many_files");
        }
        const rows = await tx
          .insert(catalogSyncUnit)
          .values(
            accepted.map((f) => ({
              operationId: op.id,
              seq: nextSeq++,
              unitKind: "file" as const,
              fileUrl: f.url,
              sourceLastmod: f.lastmod,
            })),
          )
          .onConflictDoNothing({ target: [catalogSyncUnit.operationId, catalogSyncUnit.fileUrl] })
          .returning({ seq: catalogSyncUnit.seq });
        planned = rows.length;
        duplicates += accepted.length - planned;
      }
      const filesPlanned = op.filesPlanned + planned;
      if (input.final) {
        if (filesPlanned === 0) {
          await tx
            .update(catalogSyncUnit)
            .set({
              status: "failed",
              errorCode: "index_empty",
              errorDetail: "İndekste geçerli dosya yok.",
            })
            .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.seq, 0)));
          await tx
            .update(catalogSyncOperation)
            .set({ lastErrorCode: "index_empty", lastErrorDetail: "İndekste geçerli dosya yok." })
            .where(eq(catalogSyncOperation.id, op.id));
          throw new DiscoveryError("index_empty");
        }
        const bytes = nonNegative(input.bytesDecoded);
        const transferred = nonNegative(input.bytesTransferred);
        await tx
          .update(catalogSyncUnit)
          .set({
            status: "done",
            completedAt: now,
            itemsFound: filesPlanned,
            itemsValid: filesPlanned,
            bytesDecoded: bytes,
            bytesTransferred: transferred,
          })
          .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.seq, index.seq)));
        await tx
          .update(catalogSyncOperation)
          .set({
            filesPlanned,
            indexPlannedAt: now,
            lastCheckpointAt: now,
            lastSuccessAt: now,
            bytesDecoded: op.bytesDecoded + bytes,
            bytesTransferred: op.bytesTransferred + transferred,
            leaseHeartbeatAt: now,
          })
          .where(eq(catalogSyncOperation.id, op.id));
      } else {
        await tx
          .update(catalogSyncOperation)
          .set({ filesPlanned, leaseHeartbeatAt: now })
          .where(eq(catalogSyncOperation.id, op.id));
      }
      return { planned, duplicates, rejected, filesPlanned };
    }),
  );
}

// ---------------------------------------------------------------------------
// Kayit partisi (upsert)
// ---------------------------------------------------------------------------

export interface ItemsInput {
  operationId: number;
  clientId: string;
  seq: number;
  /** Dosya icindeki parti sirasi; 0 bu denemenin ilk partisidir (deneme sayaclari sifirlanir). */
  batchIndex: number;
  items: unknown[];
  final: boolean;
  /** Final partide: dosyadaki toplam <url> sayisi ve bayt muhasebesi. */
  stats?: { itemsFound?: number; bytesDecoded?: number; bytesTransferred?: number };
}

export interface ItemsResult {
  inserted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  rejectedByCode: Partial<Record<DiscoveryRejection, number>>;
}

export async function submitDiscoveryItems(
  db: Database,
  actor: AdminActor,
  input: ItemsInput,
  now: Date = new Date(),
): Promise<ItemsResult> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  assertClient(input.clientId);
  if (!(Number.isSafeInteger(input.seq) && input.seq >= 1)) throw new DiscoveryError("bad_unit");
  if (!(Number.isSafeInteger(input.batchIndex) && input.batchIndex >= 0)) {
    throw new DiscoveryError("bad_unit");
  }
  if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS_PER_BATCH) {
    throw new DiscoveryError("batch_too_large");
  }
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const { op, policy } = await writableOperation(tx, input.operationId, input.clientId);
      const unit = await fetchingUnit(tx, op.id, input.seq);
      if (unit.unitKind !== "file") throw new DiscoveryError("bad_unit");

      const rules = {
        urlHost: policy.urlHost,
        imageHost: policy.imageHost,
      };
      const rejectedByCode: Partial<Record<DiscoveryRejection, number>> = {};
      const valid = [];
      for (const raw of input.items) {
        const r = validateDiscoveryItem(raw, rules);
        if (r.ok) valid.push(r.item);
        else rejectedByCode[r.code] = (rejectedByCode[r.code] ?? 0) + 1;
      }
      const { unique, duplicates } = dedupeItems(valid);
      const rejected = input.items.length - valid.length;

      let inserted = 0;
      let touched = 0;
      if (unique.length > 0) {
        const payload = JSON.stringify(
          unique.map((i) => ({
            external_id: i.externalId,
            code_kind: i.codeKind,
            url_path: i.urlPath,
            title: i.title,
            image_url: i.imageUrl,
          })),
        );
        // Tek ifadeyle toplu upsert. Gorulen urunun son gorulme bilgisi yazilir; baslik/gorsel
        // yalnizca yeni deger VARSA degisir (eksik alan eskisini silmez, uydurulmaz da).
        const result = await tx.execute<{ inserted: number; touched: number }>(sql`
          WITH input AS (
            SELECT * FROM jsonb_to_recordset(${payload}::jsonb)
              AS t(external_id text, code_kind text, url_path text, title text, image_url text)
          ), up AS (
            INSERT INTO catalog_discovery AS d
              (source, external_id, code_kind, url_path, title, image_url,
               first_seen_at, last_seen_at, first_seen_operation_id, last_seen_operation_id,
               last_seen_unit_seq)
            SELECT ${op.source}, external_id, code_kind, url_path, title, image_url,
                   now(), now(), ${op.id}, ${op.id}, ${input.seq}
              FROM input
            ON CONFLICT (source, external_id) DO UPDATE SET
              code_kind              = EXCLUDED.code_kind,
              url_path               = EXCLUDED.url_path,
              title                  = COALESCE(EXCLUDED.title, d.title),
              image_url              = COALESCE(EXCLUDED.image_url, d.image_url),
              last_seen_at           = EXCLUDED.last_seen_at,
              last_seen_operation_id = EXCLUDED.last_seen_operation_id,
              last_seen_unit_seq     = EXCLUDED.last_seen_unit_seq,
              missed_scans           = 0,
              presence               = 'present'
            RETURNING (xmax = 0) AS inserted
          )
          SELECT count(*) FILTER (WHERE inserted)::int AS inserted, count(*)::int AS touched FROM up
        `);
        inserted = Number(result.rows[0]?.inserted ?? 0);
        touched = Number(result.rows[0]?.touched ?? 0);
        if (inserted > 0) {
          await tx
            .update(catalogDiscoveryTally)
            .set({
              itemsTotal: sql`${catalogDiscoveryTally.itemsTotal} + ${inserted}`,
              updatedAt: now,
            })
            .where(eq(catalogDiscoveryTally.source, op.source));
        }
      }

      const first = input.batchIndex === 0;
      // Deneme sayaclari ilk partide sifirlanir; yeni urun sayaci denemeler boyunca birikir
      // (gercekten eklenen satir bir kez sayilir).
      const unitSet: PgUpdateSetSource<typeof catalogSyncUnit> = {
        itemsFound: first
          ? input.items.length
          : sql`${catalogSyncUnit.itemsFound} + ${input.items.length}`,
        itemsValid: first ? unique.length : sql`${catalogSyncUnit.itemsValid} + ${unique.length}`,
        itemsNew: sql`${catalogSyncUnit.itemsNew} + ${inserted}`,
      };
      const opSet: PgUpdateSetSource<typeof catalogSyncOperation> = {};
      if (op.status === "open") opSet.leaseHeartbeatAt = now;
      if (input.final) {
        const found = nonNegative(input.stats?.itemsFound);
        const bytes = nonNegative(input.stats?.bytesDecoded);
        const transferred = nonNegative(input.stats?.bytesTransferred);
        Object.assign(unitSet, {
          status: "done",
          completedAt: now,
          bytesDecoded: bytes,
          bytesTransferred: transferred,
          ...(found > 0 ? { itemsFound: found } : {}),
        });
        Object.assign(opSet, {
          lastCheckpointAt: now,
          lastSuccessAt: now,
          bytesDecoded: op.bytesDecoded + bytes,
          bytesTransferred: op.bytesTransferred + transferred,
        });
      }
      await tx
        .update(catalogSyncUnit)
        .set(unitSet)
        .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.seq, unit.seq)));
      if (Object.keys(opSet).length > 0) {
        await tx.update(catalogSyncOperation).set(opSet).where(eq(catalogSyncOperation.id, op.id));
      }
      return {
        inserted,
        updated: touched - inserted,
        duplicates,
        rejected,
        rejectedByCode,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Hata / engel bildirimi
// ---------------------------------------------------------------------------

export interface FailureInput {
  operationId: number;
  clientId: string;
  seq: number;
  outcome: "failed" | "blocked";
  errorCode: string;
  errorDetail?: string | null;
  bytesDecoded?: number;
  bytesTransferred?: number;
}

export async function reportDiscoveryFailure(
  db: Database,
  actor: AdminActor,
  input: FailureInput,
  now: Date = new Date(),
): Promise<{ status: string }> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  assertClient(input.clientId);
  if (input.outcome !== "failed" && input.outcome !== "blocked")
    throw new DiscoveryError("bad_outcome");
  if (!(Number.isSafeInteger(input.seq) && input.seq >= 0)) throw new DiscoveryError("bad_unit");
  const code =
    typeof input.errorCode === "string" && ERROR_CODE.test(input.errorCode)
      ? input.errorCode
      : "unknown_error";
  const detail = cleanDetail(input.errorDetail);
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const { op } = await writableOperation(tx, input.operationId, input.clientId);
      await fetchingUnit(tx, op.id, input.seq);
      const bytes = nonNegative(input.bytesDecoded);
      const transferred = nonNegative(input.bytesTransferred);
      await tx
        .update(catalogSyncUnit)
        .set({
          status: input.outcome,
          errorCode: code,
          errorDetail: detail,
          bytesDecoded: bytes,
          bytesTransferred: transferred,
        })
        .where(and(eq(catalogSyncUnit.operationId, op.id), eq(catalogSyncUnit.seq, input.seq)));
      const blocked = input.outcome === "blocked";
      const [updated] = await tx
        .update(catalogSyncOperation)
        .set({
          lastErrorCode: code,
          lastErrorDetail: detail,
          bytesDecoded: op.bytesDecoded + bytes,
          bytesTransferred: op.bytesTransferred + transferred,
          // Engel: operasyon durur; yonetici bekleme suresinden sonra elle surdurur.
          ...(blocked
            ? {
                status: "blocked" as const,
                blockedAt: now,
                leaseClient: null,
                leaseHeartbeatAt: null,
              }
            : op.status === "open"
              ? { leaseHeartbeatAt: now }
              : {}),
        })
        .where(eq(catalogSyncOperation.id, op.id))
        .returning();
      return { status: updated?.status ?? op.status };
    }),
  );
}

// ---------------------------------------------------------------------------
// Duraklat / surdur / iptal
// ---------------------------------------------------------------------------

export async function pauseDiscoveryOperation(
  db: Database,
  actor: AdminActor,
  input: { operationId: number },
  now: Date = new Date(),
): Promise<DiscoveryOperationView> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  await mapErrors(() => settleExpiry(db, input.operationId, now));
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const op = await lockOperation(tx, input.operationId);
      if (op.status !== "open") throw new DiscoveryError("operation_not_open", op.status);
      const [updated] = await tx
        .update(catalogSyncOperation)
        .set({ status: "paused" })
        .where(eq(catalogSyncOperation.id, op.id))
        .returning();
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_discovery.pause",
        targetType: "catalog_sync_operation",
        targetId: op.id,
        before: { status: op.status },
        after: { status: "paused" },
      });
      return toView(updated ?? op, now);
    }),
  );
}

/**
 * Surdurme bu istemciye kirayi verir. Baska bir istemcinin TAZE kirasi varsa reddedilir
 * (iki sekme ayni operasyonu calistirmaz). Engelli operasyon yalnizca bekleme suresi
 * dolduktan sonra surdurulebilir.
 */
export async function resumeDiscoveryOperation(
  db: Database,
  actor: AdminActor,
  input: { operationId: number; clientId: string },
  now: Date = new Date(),
): Promise<DiscoveryOperationView> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  assertClient(input.clientId);
  await mapErrors(() => settleExpiry(db, input.operationId, now));
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const op = await lockOperation(tx, input.operationId);
      const policy = await loadPolicy(tx, op.source);
      if (!policy.enabled) throw new DiscoveryError("discovery_disabled");
      if (!ACTIVE.includes(op.status)) throw new DiscoveryError("operation_closed", op.status);
      if (op.status === "blocked") {
        const allowed = (op.blockedAt?.getTime() ?? 0) + policy.blockedCooldownHours * 3_600_000;
        if (now.getTime() < allowed) {
          throw new DiscoveryError("blocked_cooldown", new Date(allowed).toISOString());
        }
      }
      if (op.leaseClient && op.leaseClient !== input.clientId && leaseFresh(op, now)) {
        throw new DiscoveryError("lease_held_by_other");
      }
      const [updated] = await tx
        .update(catalogSyncOperation)
        .set({ status: "open", leaseClient: input.clientId, leaseHeartbeatAt: now })
        .where(eq(catalogSyncOperation.id, op.id))
        .returning();
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_discovery.resume",
        targetType: "catalog_sync_operation",
        targetId: op.id,
        before: { status: op.status },
        after: { status: "open" },
      });
      return toView(updated ?? op, now);
    }),
  );
}

export async function cancelDiscoveryOperation(
  db: Database,
  actor: AdminActor,
  input: { operationId: number },
  now: Date = new Date(),
): Promise<DiscoveryOperationView> {
  assertCapability(actor, "catalog.write");
  assertId(input.operationId);
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const op = await lockOperation(tx, input.operationId);
      if (!ACTIVE.includes(op.status)) throw new DiscoveryError("operation_closed", op.status);
      const [updated] = await tx
        .update(catalogSyncOperation)
        .set({
          status: "cancelled",
          removalState: op.kind === "weekly_refresh" ? "skipped_partial" : "not_applicable",
          leaseClient: null,
          leaseHeartbeatAt: null,
        })
        .where(eq(catalogSyncOperation.id, op.id))
        .returning();
      if (op.quotaRunId) {
        // Hic kaynak istegi atilmadan iptal edilen yenileme kotadan dusulur (0070 'released').
        await tx
          .update(collectionRun)
          .set({
            status: op.requestsMade === 0 ? "released" : "aborted",
            summary: { reason: "cancelled", mode: "sitemap_refresh", operationId: op.id },
          })
          .where(and(eq(collectionRun.id, op.quotaRunId), eq(collectionRun.status, "open")));
      }
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_discovery.cancel",
        targetType: "catalog_sync_operation",
        targetId: op.id,
        before: { status: op.status, requests: op.requestsMade },
        after: { status: "cancelled" },
      });
      return toView(updated ?? op, now);
    }),
  );
}
