/**
 * Yonetici tarayicisindan katalog toplama (karar 0117).
 *
 * TS yalniz `catalog_intake_record`, `collection_run` ve `collection_unit`
 * yazar; `offer`/`price_point` yazimi Python `feeds hb-merge`tir (mimari sinir).
 * Kota SISTEM seviyesindedir: tetikleyici (migration 0070) kosu rezervasyonunu
 * reddeder; buradaki hesap yalnizca arayuze "ne zaman" bilgisi verir.
 */
import {
  catalogIntakeRecord,
  collectionRun,
  collectionSource,
  collectionUnit,
  type Database,
} from "@arilla/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { type RecordRejection, validateIntakeRecord } from "./validate.ts";

export const MAX_BATCH_RECORDS = 500;
export const MAX_BATCH_UNITS = 100;

export class CollectionError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(code: string, detail?: string) {
    super(code);
    this.name = "CollectionError";
    this.code = code;
    this.detail = detail;
  }
}

const TRIGGER_CODES =
  /(collection_(?:source_unknown|disabled|quota_interval|quota_month|run_not_open|run_expired|run_immutable|run_closed|requests_decrease|observed_at_out_of_range))/;

/**
 * Postgres tetikleyici istisnalari bilinen `collection_*` kodlariyla gelir. Surucu
 * hatasi sarmalar (mesaj sorgu metnini icerir); yalniz bilinen kodlar taninir.
 */
export function collectionErrorFrom(error: unknown): CollectionError | null {
  let current: unknown = error;
  let found: CollectionError | null = null;
  for (let i = 0; i < 5 && current; i++) {
    const e = current as { message?: unknown; detail?: unknown; cause?: unknown };
    if (typeof e.message === "string") {
      const m = TRIGGER_CODES.exec(e.message);
      if (m) {
        found = new CollectionError(
          m[1] as string,
          typeof e.detail === "string" ? e.detail : undefined,
        );
      }
    }
    current = e.cause;
  }
  return found;
}

const SOURCES = new Set(["hepsiburada"]);

function assertSource(source: unknown): asserts source is string {
  if (typeof source !== "string" || !SOURCES.has(source)) {
    throw new CollectionError("unknown_source");
  }
}

export interface QuotaState {
  enabled: boolean;
  minIntervalDays: number;
  maxRunsPerMonth: number;
  runsThisMonth: number;
  /** Bu istekte rezervasyon yapilabilir mi (tetikleyici yine son karari verir). */
  canStart: boolean;
  blockedBy: "disabled" | "interval" | "month" | "open_run" | null;
  nextAllowedAt: Date | null;
  /** Bir sonraki koşunun türü ve istek bütçesi (ilk yükleme ile güncelleme ayrı bütçelidir). */
  nextKind: "initial" | "refresh";
  nextMaxRequests: number;
  initialLoadExempt: boolean;
  permissionBasis: string;
  permissionNote: string | null;
}

export interface RunView {
  id: number;
  kind: "initial" | "refresh";
  status: string;
  reservedAt: Date;
  expiresAt: Date;
  closedAt: Date | null;
  requestsMade: number;
  maxRequests: number;
  checkpoint: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  /** Kosu ayarlari; sitemap yenilemesinde `{ mode: "sitemap_refresh" }` (karar 0120). */
  options: Record<string, unknown>;
}

export interface CatalogCollectionStatus {
  source: string;
  quota: QuotaState;
  openRun: RunView | null;
  recentRuns: RunView[];
}

function toRunView(r: typeof collectionRun.$inferSelect): RunView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    reservedAt: r.reservedAt,
    expiresAt: r.expiresAt,
    closedAt: r.closedAt,
    requestsMade: r.requestsMade,
    maxRequests: r.maxRequests,
    checkpoint: r.checkpoint,
    summary: r.summary,
    options: r.options,
  };
}

/** Suresi dolmus acik kosu kapatilir (tetikleyici kapali kosuyu yeniden acmaz). */
async function expireStaleRuns(db: Database, source: string): Promise<void> {
  await db
    .update(collectionRun)
    .set({ status: "aborted", summary: sql`jsonb_build_object('reason', 'expired')` })
    .where(
      and(
        eq(collectionRun.source, source),
        eq(collectionRun.status, "open"),
        sql`${collectionRun.expiresAt} <= now()`,
      ),
    );
}

export async function getCollectionStatus(
  db: Database,
  actor: AdminActor,
  source: string,
  now: Date = new Date(),
): Promise<CatalogCollectionStatus> {
  assertCapability(actor, "catalog.write");
  assertSource(source);
  await expireStaleRuns(db, source);
  const [policy] = await db
    .select()
    .from(collectionSource)
    .where(eq(collectionSource.source, source));
  if (!policy) throw new CollectionError("unknown_source");
  const runs = await db
    .select()
    .from(collectionRun)
    .where(eq(collectionRun.source, source))
    .orderBy(desc(collectionRun.reservedAt))
    .limit(12);
  // Ilk yukleme kota disi beyan edildiyse (declared_extended + not) araliga/aya sayilmaz.
  const counted = runs.filter(
    (r) => r.status !== "released" && !(r.kind === "initial" && policy.initialLoadExempt),
  );
  const anyCounted = runs.some((r) => r.status !== "released");
  const month = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  const runsThisMonth = counted.filter((r) => month(r.reservedAt) === month(now)).length;
  const last = counted[0]?.reservedAt ?? null;
  const nextAllowedAt = last
    ? new Date(last.getTime() + policy.minIntervalDays * 86_400_000)
    : null;
  const open = runs.find((r) => r.status === "open") ?? null;
  let blockedBy: QuotaState["blockedBy"] = null;
  if (!policy.enabled) blockedBy = "disabled";
  else if (open) blockedBy = "open_run";
  else if (nextAllowedAt && now < nextAllowedAt) blockedBy = "interval";
  else if (runsThisMonth >= policy.maxRunsPerMonth) blockedBy = "month";
  return {
    source,
    quota: {
      enabled: policy.enabled,
      minIntervalDays: policy.minIntervalDays,
      maxRunsPerMonth: policy.maxRunsPerMonth,
      runsThisMonth,
      canStart: blockedBy === null,
      blockedBy,
      nextAllowedAt,
      nextKind: anyCounted ? "refresh" : "initial",
      nextMaxRequests: anyCounted ? policy.refreshMaxRequests : policy.initialMaxRequests,
      initialLoadExempt: policy.initialLoadExempt,
      permissionBasis: policy.permissionBasis,
      permissionNote: policy.permissionNote,
    },
    openRun: open ? toRunView(open) : null,
    recentRuns: runs.slice(0, 6).map(toRunView),
  };
}

export interface StartRunInput {
  source: string;
  options?: { queries?: number; maxPages?: number };
}

/** Kota tetikleyicisi reddederse `CollectionError` (collection_quota_*) firlatir. */
export async function startCollectionRun(
  db: Database,
  actor: AdminActor,
  input: StartRunInput,
): Promise<RunView> {
  assertCapability(actor, "catalog.write");
  assertSource(input.source);
  await expireStaleRuns(db, input.source);
  const options = {
    queries: Math.min(Math.max(Number(input.options?.queries) || 0, 0), 5000),
    maxPages: Math.min(Math.max(Number(input.options?.maxPages) || 1, 1), 50),
  };
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(collectionRun)
        .values({
          source: input.source,
          startedBy: actor.userId,
          // Tetikleyici bu ikisini politikadan yeniden yazar.
          expiresAt: new Date(),
          maxRequests: 1,
          options,
        })
        .returning();
      if (!row) throw new CollectionError("insert_failed");
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_collection.start",
        targetType: "collection_run",
        targetId: row.id,
        before: null,
        after: { source: input.source, maxRequests: row.maxRequests },
      });
      return toRunView(row);
    });
  } catch (error) {
    const mapped = collectionErrorFrom(error);
    if (mapped) throw mapped;
    // Acik kosu zaten var (kismi benzersiz indeks).
    if (
      /collection_run_one_open_uniq/.test(
        String((error as { cause?: { message?: string } })?.cause?.message ?? error),
      )
    ) {
      throw new CollectionError("collection_run_already_open");
    }
    throw error;
  }
}

export interface UnitInput {
  query: string;
  page: number;
  status: "done" | "empty" | "failed" | "blocked";
  itemsFound: number;
  itemsNew: number;
  totalHint?: number | null;
  errorCode?: string | null;
  fetchedAt: string;
}

export interface BatchInput {
  runId: number;
  records: unknown[];
  units: UnitInput[];
  /** Tarayicinin bu kosuda attigi toplam kaynak istegi (azalamaz). */
  requestsMade: number;
  checkpoint?: Record<string, unknown> | null;
}

export interface BatchResult {
  inserted: number;
  duplicates: number;
  rejected: number;
  rejectedByCode: Partial<Record<RecordRejection, number>>;
  requestsMade: number;
}

const UNIT_ERROR = /^[a-z0-9_]{2,60}$/;

export async function submitCollectionBatch(
  db: Database,
  actor: AdminActor,
  input: BatchInput,
  now: Date = new Date(),
): Promise<BatchResult> {
  assertCapability(actor, "catalog.write");
  if (!(Number.isSafeInteger(input.runId) && input.runId > 0)) throw new CollectionError("bad_run");
  if (!Array.isArray(input.records) || input.records.length > MAX_BATCH_RECORDS) {
    throw new CollectionError("batch_too_large");
  }
  if (!Array.isArray(input.units) || input.units.length > MAX_BATCH_UNITS) {
    throw new CollectionError("batch_too_large");
  }
  if (!(Number.isSafeInteger(input.requestsMade) && input.requestsMade >= 0)) {
    throw new CollectionError("bad_requests");
  }
  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(collectionRun)
        .where(eq(collectionRun.id, input.runId))
        .for("update");
      if (run?.status !== "open") throw new CollectionError("collection_run_not_open");
      if (now.getTime() >= run.expiresAt.getTime())
        throw new CollectionError("collection_run_expired");
      if (run.startedBy !== actor.userId) throw new CollectionError("run_owned_by_other");
      if (input.requestsMade > run.maxRequests)
        throw new CollectionError("request_budget_exceeded");
      if (input.requestsMade < run.requestsMade) throw new CollectionError("bad_requests");

      const [policy] = await tx
        .select()
        .from(collectionSource)
        .where(eq(collectionSource.source, run.source));
      if (!policy?.enabled) throw new CollectionError("collection_disabled");

      const rules = {
        urlHost: "hepsiburada.com",
        imageHost: "hepsiburada.net",
        now,
        runStart: run.reservedAt,
      };
      const rejectedByCode: Partial<Record<RecordRejection, number>> = {};
      const valid = [];
      const seen = new Set<string>();
      let duplicatesInBatch = 0;
      for (const raw of input.records) {
        const result = validateIntakeRecord(raw, rules);
        if (!result.ok) {
          rejectedByCode[result.code] = (rejectedByCode[result.code] ?? 0) + 1;
          continue;
        }
        if (seen.has(result.record.externalId)) {
          duplicatesInBatch += 1;
          continue;
        }
        seen.add(result.record.externalId);
        valid.push(result.record);
      }
      const rejected = input.records.length - valid.length - duplicatesInBatch;

      let inserted = 0;
      if (valid.length > 0) {
        const rows = await tx
          .insert(catalogIntakeRecord)
          .values(
            valid.map((r) => ({
              runId: run.id,
              externalId: r.externalId,
              title: r.title,
              url: r.url,
              priceMinor: r.priceMinor,
              listPriceMinor: r.listPriceMinor,
              currency: r.currency,
              inStock: r.inStock,
              imageUrl: r.imageUrl,
              brand: r.brand,
              categoryRaw: r.categoryRaw,
              sellerExternalId: r.sellerExternalId,
              sellerName: r.sellerName,
              variantLabel: r.variantLabel,
              gtin: r.gtin,
              foundVia: r.foundVia,
              sourceObservedAt: r.sourceObservedAt,
            })),
          )
          .onConflictDoNothing({
            target: [catalogIntakeRecord.runId, catalogIntakeRecord.externalId],
          })
          .returning({ id: catalogIntakeRecord.id });
        inserted = rows.length;
      }

      for (const u of input.units) {
        const query = typeof u.query === "string" ? u.query.trim().slice(0, 200) : "";
        const fetched = new Date(u.fetchedAt);
        if (
          !query ||
          !Number.isSafeInteger(u.page) ||
          u.page < 1 ||
          u.page > 200 ||
          !["done", "empty", "failed", "blocked"].includes(u.status) ||
          !Number.isSafeInteger(u.itemsFound) ||
          u.itemsFound < 0 ||
          !Number.isSafeInteger(u.itemsNew) ||
          u.itemsNew < 0 ||
          Number.isNaN(fetched.getTime())
        ) {
          throw new CollectionError("bad_unit");
        }
        const errorCode = u.errorCode && UNIT_ERROR.test(u.errorCode) ? u.errorCode : null;
        await tx
          .insert(collectionUnit)
          .values({
            runId: run.id,
            kind: "query",
            unitKey: query,
            page: u.page,
            status: u.status,
            itemsFound: u.itemsFound,
            itemsNew: Math.min(u.itemsNew, u.itemsFound),
            totalHint:
              Number.isSafeInteger(u.totalHint) && (u.totalHint as number) >= 0
                ? (u.totalHint as number)
                : null,
            errorCode,
            fetchedAt: fetched,
          })
          .onConflictDoUpdate({
            target: [
              collectionUnit.runId,
              collectionUnit.kind,
              collectionUnit.unitKey,
              collectionUnit.page,
            ],
            set: {
              status: u.status,
              itemsFound: u.itemsFound,
              itemsNew: Math.min(u.itemsNew, u.itemsFound),
              errorCode,
              fetchedAt: fetched,
            },
          });
      }

      const checkpoint =
        input.checkpoint && typeof input.checkpoint === "object" ? input.checkpoint : null;
      await tx
        .update(collectionRun)
        .set({ requestsMade: input.requestsMade, ...(checkpoint ? { checkpoint } : {}) })
        .where(eq(collectionRun.id, run.id));
      return {
        inserted,
        duplicates: duplicatesInBatch + (valid.length - inserted),
        rejected,
        rejectedByCode,
        requestsMade: input.requestsMade,
      };
    });
  } catch (error) {
    const mapped = collectionErrorFrom(error);
    if (mapped) throw mapped;
    throw error;
  }
}

export interface CoverageReport {
  runId: number;
  uniqueRecords: number;
  pendingMerge: number;
  queries: number;
  pagesFetched: number;
  itemsSeen: number;
  failedUnits: number;
  blockedUnits: number;
  /** Sayfa tavaninda kesilen (son sayfa hala yeni urun getiriyordu) sorgu sayisi. */
  queriesCappedByPageLimit: number;
  /** Ilk sayfadan sonra sayfalama yeni urun getirmeyen sorgular: sayfalama dogrulanamadi. */
  queriesPaginationUnconfirmed: number;
  note: string;
}

export async function coverageReport(
  db: Database,
  actor: AdminActor,
  runId: number,
): Promise<CoverageReport> {
  assertCapability(actor, "catalog.write");
  const units = await db.select().from(collectionUnit).where(eq(collectionUnit.runId, runId));
  const byQuery = new Map<string, (typeof units)[number][]>();
  for (const u of units) {
    const list = byQuery.get(u.unitKey) ?? [];
    list.push(u);
    byQuery.set(u.unitKey, list);
  }
  let capped = 0;
  let unconfirmed = 0;
  for (const pages of byQuery.values()) {
    pages.sort((a, b) => a.page - b.page);
    const last = pages[pages.length - 1];
    if (last && last.status === "done" && last.itemsNew > 0) capped += 1;
    if (pages.length > 1 && pages.slice(1).every((p) => p.itemsNew === 0)) unconfirmed += 1;
  }
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) FILTER (WHERE merged_at IS NULL)::int`,
    })
    .from(catalogIntakeRecord)
    .where(eq(catalogIntakeRecord.runId, runId));
  return {
    runId,
    uniqueRecords: counts?.total ?? 0,
    pendingMerge: counts?.pending ?? 0,
    queries: byQuery.size,
    pagesFetched: units.filter((u) => u.status === "done" || u.status === "empty").length,
    itemsSeen: units.reduce((s, u) => s + u.itemsFound, 0),
    failedUnits: units.filter((u) => u.status === "failed").length,
    blockedUnits: units.filter((u) => u.status === "blocked").length,
    queriesCappedByPageLimit: capped,
    queriesPaginationUnconfirmed: unconfirmed,
    note: "Kapsam yalnizca taranan sorgularla sinirlidir; kaynagin tum katalogu varsayilmaz.",
  };
}

export async function closeCollectionRun(
  db: Database,
  actor: AdminActor,
  input: { runId: number; outcome: "completed" | "aborted" },
): Promise<CoverageReport> {
  assertCapability(actor, "catalog.write");
  if (input.outcome !== "completed" && input.outcome !== "aborted") {
    throw new CollectionError("bad_outcome");
  }
  const report = await coverageReport(db, actor, input.runId);
  try {
    await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(collectionRun)
        .where(eq(collectionRun.id, input.runId))
        .for("update");
      if (run?.status !== "open") throw new CollectionError("collection_run_not_open");
      // Hic istek atilmadan birakilan kosu kotadan dusulur.
      const status = run.requestsMade === 0 ? "released" : input.outcome;
      await tx
        .update(collectionRun)
        .set({ status, summary: report as unknown as Record<string, unknown> })
        .where(eq(collectionRun.id, run.id));
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_collection.close",
        targetType: "collection_run",
        targetId: run.id,
        before: { status: run.status },
        after: { status, uniqueRecords: report.uniqueRecords, requests: run.requestsMade },
      });
    });
  } catch (error) {
    const mapped = collectionErrorFrom(error);
    if (mapped) throw mapped;
    throw error;
  }
  return report;
}
