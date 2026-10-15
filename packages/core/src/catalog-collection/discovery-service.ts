/**
 * Katalog kesif defteri servisi (karar 0120). Sitemap dosyasi bazinda plan, onay,
 * checkpoint ve fiyatsiz urun kimligi yazimi. Kota 0070 tetikleyicisindedir: bir
 * KOSU bir kota hakkidir; kosu icindeki dosya/sayfa istekleri ayri hak sayilmaz,
 * yalniz istek/bayt/hiz guvenlik sinirlarina tabidir. Hicbir satir silinmez ve
 * eksik tarama nedeniyle hicbir sey pasiflestirilmez (yalniz last_seen guncellenir).
 */
import type { Database } from "@arilla/db";
import { catalogDiscovery, collectionRun, collectionSource, collectionUnit } from "@arilla/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import {
  type DiscoveryItemInput,
  type DiscoveryRejection,
  UNIT_KEY,
  validateDiscoveryItem,
} from "./discovery-validate.ts";
import { CollectionError, collectionErrorFrom } from "./service.ts";

export const MAX_DISCOVERY_ITEMS = 12_000;
export const MAX_PLAN_UNITS = 10_000;
/**
 * Veritabani boyutu tavani (disk doluluguna karsi guvenli durdurma). Disk bos alani
 * PostgreSQL'den gorulmez; bu yuzden mutlak boyut tavani + parti basina tahmini buyume
 * kullanilir. Tavan asilirsa parti REDDEDILIR (hicbir sey yazilmaz, hicbir sey silinmez).
 * Varsayilan 60 GiB: 193 GB disk icin WAL, yedek ve gecici dosyalara pay birakir.
 */
export const DEFAULT_DB_SIZE_CEILING_BYTES = 60 * 1024 ** 3;
/** Satir basina tahmini kalici buyume (veri + PK + WAL payi); olcum: ~273 B/satir. */
export const ESTIMATED_BYTES_PER_NEW_ROW = 600;
const ORIGINS = ["vps", "admin_wifi", "admin_wired", "admin_mobile"] as const;
export type TransferOriginInput = (typeof ORIGINS)[number];
const UNIT_KINDS = ["sitemap_file", "listing_page"] as const;
export type DiscoveryUnitKind = (typeof UNIT_KINDS)[number];

async function openOwnedRun(
  tx: Pick<Database, "select">,
  actor: AdminActor,
  runId: number,
  now: Date,
) {
  if (!(Number.isSafeInteger(runId) && runId > 0)) throw new CollectionError("bad_run");
  const [run] = await tx
    .select()
    .from(collectionRun)
    .where(eq(collectionRun.id, runId))
    .for("update");
  if (run?.status !== "open") throw new CollectionError("collection_run_not_open");
  if (now.getTime() >= run.expiresAt.getTime()) throw new CollectionError("collection_run_expired");
  if (run.startedBy !== actor.userId) throw new CollectionError("run_owned_by_other");
  return run;
}

/** Sitemap indeksindeki dosyalari bekleyen birim olarak planlar (tekrar cagri guvenli). */
export async function planDiscoveryUnits(
  db: Database,
  actor: AdminActor,
  input: { runId: number; kind: DiscoveryUnitKind; keys: string[] },
  now: Date = new Date(),
): Promise<{ planned: number; alreadyPlanned: number }> {
  assertCapability(actor, "catalog.write");
  if (!UNIT_KINDS.includes(input.kind)) throw new CollectionError("bad_unit");
  if (
    !Array.isArray(input.keys) ||
    input.keys.length === 0 ||
    input.keys.length > MAX_PLAN_UNITS ||
    !input.keys.every((k) => typeof k === "string" && UNIT_KEY.test(k))
  ) {
    throw new CollectionError("bad_unit");
  }
  return db.transaction(async (tx) => {
    await openOwnedRun(tx, actor, input.runId, now);
    const [base] = await tx
      .select({ n: sql<number>`coalesce(max(${collectionUnit.unitSeq}) + 1, 0)::int` })
      .from(collectionUnit)
      .where(and(eq(collectionUnit.runId, input.runId), eq(collectionUnit.kind, input.kind)));
    const start = base?.n ?? 0;
    const rows = await tx
      .insert(collectionUnit)
      .values(
        input.keys.map((unitKey, i) => ({
          runId: input.runId,
          kind: input.kind,
          unitKey,
          page: 1,
          status: "pending" as const,
          unitSeq: start + i,
        })),
      )
      .onConflictDoNothing()
      .returning({ k: collectionUnit.unitKey });
    return { planned: rows.length, alreadyPlanned: input.keys.length - rows.length };
  });
}

/** Siradaki bekleyen/basarisiz birimler (kaldigi yerden devam). Denemesi tukenen atlanir. */
export async function nextDiscoveryUnits(
  db: Database,
  actor: AdminActor,
  input: { runId: number; limit?: number; maxAttempts?: number },
) {
  assertCapability(actor, "catalog.write");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 1), 1), 50);
  const maxAttempts = Math.min(Math.max(Math.trunc(input.maxAttempts ?? 3), 1), 10);
  return db
    .select({
      kind: collectionUnit.kind,
      unitKey: collectionUnit.unitKey,
      unitSeq: collectionUnit.unitSeq,
      attempts: collectionUnit.attempts,
    })
    .from(collectionUnit)
    .where(
      and(
        eq(collectionUnit.runId, input.runId),
        inArray(collectionUnit.status, ["pending", "failed"]),
        sql`${collectionUnit.attempts} < ${maxAttempts}`,
      ),
    )
    .orderBy(asc(collectionUnit.unitSeq), asc(collectionUnit.unitKey))
    .limit(limit);
}

/**
 * Yonetici indirme onayi: bu kosuda en fazla `bytes` indirilebilir (politika tavanini
 * asamaz) ve ag kaynagi beyan edilir. Onay olmadan bayt gonderimi reddedilir.
 */
export async function approveRunDownload(
  db: Database,
  actor: AdminActor,
  input: { runId: number; bytes: number; transferOrigin: TransferOriginInput },
  now: Date = new Date(),
): Promise<{ approvedBytes: number; maxBytes: number }> {
  assertCapability(actor, "catalog.write");
  if (!(Number.isSafeInteger(input.bytes) && input.bytes > 0))
    throw new CollectionError("bad_bytes");
  if (!ORIGINS.includes(input.transferOrigin)) throw new CollectionError("bad_transfer_origin");
  try {
    return await db.transaction(async (tx) => {
      const run = await openOwnedRun(tx, actor, input.runId, now);
      if (input.bytes > run.maxBytes) throw new CollectionError("download_exceeds_policy");
      if (input.bytes < run.bytesDownloaded) throw new CollectionError("bad_bytes");
      const approved = Math.max(input.bytes, run.downloadApprovedBytes);
      await tx
        .update(collectionRun)
        .set({
          downloadApprovedBytes: approved,
          downloadApprovedBy: actor.userId,
          downloadApprovedAt: now,
          transferOrigin: input.transferOrigin,
        })
        .where(eq(collectionRun.id, run.id));
      await recordAdminEvent(tx, {
        actor,
        action: "catalog_collection.approve_download",
        targetType: "collection_run",
        targetId: run.id,
        before: { approvedBytes: run.downloadApprovedBytes },
        after: { approvedBytes: approved, transferOrigin: input.transferOrigin },
      });
      return { approvedBytes: approved, maxBytes: run.maxBytes };
    });
  } catch (error) {
    throw collectionErrorFrom(error) ?? error;
  }
}

export interface DiscoveryBatchInput {
  runId: number;
  kind: DiscoveryUnitKind;
  unitKey: string;
  status: "done" | "empty" | "failed" | "blocked";
  /** Bu birim icin alinan bayt (toplam degil, artis). */
  bytesReceived: number;
  /** Tarayicinin bu kosuda attigi toplam kaynak istegi (azalamaz). */
  requestsMade: number;
  fetchedAt: string;
  items: unknown[];
  errorCode?: string | null;
  checkpoint?: Record<string, unknown> | null;
}

export interface DiscoveryBatchResult {
  inserted: number;
  seenAgain: number;
  rejected: number;
  rejectedByCode: Partial<Record<DiscoveryRejection, number>>;
  requestsMade: number;
  bytesDownloaded: number;
}

const ERROR_CODE = /^[a-z0-9_]{2,60}$/;
const CHUNK = 2000;

/** Bir birimin (sitemap dosyasi) sonucunu tek islemde yazar: defter + birim + kosu sayaclari. */
export async function submitDiscoveryBatch(
  db: Database,
  actor: AdminActor,
  input: DiscoveryBatchInput,
  now: Date = new Date(),
  guard: { maxDatabaseBytes?: number } = {},
): Promise<DiscoveryBatchResult> {
  assertCapability(actor, "catalog.write");
  if (!UNIT_KINDS.includes(input.kind) || !UNIT_KEY.test(String(input.unitKey))) {
    throw new CollectionError("bad_unit");
  }
  if (!["done", "empty", "failed", "blocked"].includes(input.status)) {
    throw new CollectionError("bad_unit");
  }
  if (!Array.isArray(input.items) || input.items.length > MAX_DISCOVERY_ITEMS) {
    throw new CollectionError("batch_too_large");
  }
  if (input.status !== "done" && input.items.length > 0) throw new CollectionError("bad_unit");
  if (!(Number.isSafeInteger(input.bytesReceived) && input.bytesReceived >= 0)) {
    throw new CollectionError("bad_bytes");
  }
  if (!(Number.isSafeInteger(input.requestsMade) && input.requestsMade >= 0)) {
    throw new CollectionError("bad_requests");
  }
  const fetched = new Date(input.fetchedAt);
  if (Number.isNaN(fetched.getTime())) throw new CollectionError("bad_unit");
  const errorCode = input.errorCode && ERROR_CODE.test(input.errorCode) ? input.errorCode : null;

  try {
    return await db.transaction(async (tx) => {
      const run = await openOwnedRun(tx, actor, input.runId, now);
      const [policy] = await tx
        .select()
        .from(collectionSource)
        .where(eq(collectionSource.source, run.source));
      if (!policy?.enabled) throw new CollectionError("collection_disabled");

      // Istek tavani ve hiz: kosu icinde istek sayisi artar ama butceyi asamaz.
      if (input.requestsMade > run.maxRequests)
        throw new CollectionError("request_budget_exceeded");
      if (input.requestsMade < run.requestsMade) throw new CollectionError("bad_requests");
      const newRequests = input.requestsMade - run.requestsMade;
      const [times] = await tx
        .select({
          last: sql<Date | null>`max(${collectionUnit.fetchedAt})`,
          blocked: sql<Date | null>`max(${collectionUnit.fetchedAt}) FILTER (WHERE ${collectionUnit.status} = 'blocked')`,
        })
        .from(collectionUnit)
        .where(eq(collectionUnit.runId, run.id));
      if (newRequests > 0 && times?.last) {
        const gap = fetched.getTime() - new Date(times.last).getTime();
        if (gap < policy.minRequestIntervalMs * newRequests) {
          throw new CollectionError("request_rate_exceeded");
        }
      }
      // Engel sogumasi: son engelden sonra bekleme dolmadan yeni birim kabul edilmez.
      if (times?.blocked) {
        const until = new Date(times.blocked).getTime() + policy.blockedCooldownMinutes * 60_000;
        if (now.getTime() < until) throw new CollectionError("blocked_cooldown");
      }
      // Bayt: onayli tavani asamaz (onay yoksa 0, yani hicbir bayt kabul edilmez).
      const bytesDownloaded = run.bytesDownloaded + input.bytesReceived;
      if (bytesDownloaded > run.downloadApprovedBytes) {
        throw new CollectionError(
          run.downloadApprovedBytes === 0 ? "download_not_approved" : "download_budget_exceeded",
        );
      }

      const rules = { urlHost: "hepsiburada.com", imageHost: "hepsiburada.net" };
      const rejectedByCode: Partial<Record<DiscoveryRejection, number>> = {};
      const byId = new Map<string, DiscoveryItemInput>();
      let rejected = 0;
      const reject = (code: DiscoveryRejection) => {
        rejected += 1;
        rejectedByCode[code] = (rejectedByCode[code] ?? 0) + 1;
      };
      for (const raw of input.items) {
        const v = validateDiscoveryItem(raw, rules);
        if (!v.ok) reject(v.code);
        else if (v.item.sourceUnitKey !== input.unitKey) reject("unit_key");
        else byId.set(v.item.externalId, v.item);
      }
      const valid = [...byId.values()];

      // Disk korumasi: tavana yaklasan veritabanina yeni kimlik yazilmaz.
      const ceiling = guard.maxDatabaseBytes ?? DEFAULT_DB_SIZE_CEILING_BYTES;
      if (valid.length > 0) {
        const sizeRes = await tx.execute(
          sql`SELECT pg_database_size(current_database())::bigint AS size`,
        );
        const size = Number((sizeRes.rows[0] as { size: string | number } | undefined)?.size ?? 0);
        if (size + valid.length * ESTIMATED_BYTES_PER_NEW_ROW > ceiling) {
          throw new CollectionError("database_size_limit");
        }
      }

      let inserted = 0;
      for (let i = 0; i < valid.length; i += CHUNK) {
        // xmax = 0 ise satir yeni eklendi; aksi halde mevcut satir yalniz last_seen aldi.
        const res = await tx
          .insert(catalogDiscovery)
          .values(
            valid.slice(i, i + CHUNK).map((it) => ({
              source: run.source,
              externalId: it.externalId,
              codeKind: it.codeKind,
              url: it.url,
              title: it.title,
              imageUrl: it.imageUrl,
              sourceUnitKey: it.sourceUnitKey,
              firstSeenRunId: run.id,
              lastSeenRunId: run.id,
              firstSeenAt: fetched,
              lastSeenAt: fetched,
            })),
          )
          .onConflictDoUpdate({
            target: [catalogDiscovery.source, catalogDiscovery.externalId],
            set: {
              lastSeenRunId: run.id,
              lastSeenAt: sql`greatest(${catalogDiscovery.lastSeenAt}, excluded.last_seen_at)`,
              sourceUnitKey: sql`excluded.source_unit_key`,
              // Bos gelen alan eldeki degeri silmez.
              title: sql`coalesce(excluded.title, ${catalogDiscovery.title})`,
              imageUrl: sql`coalesce(excluded.image_url, ${catalogDiscovery.imageUrl})`,
            },
          })
          .returning({ isNew: sql<boolean>`(xmax = 0)` });
        inserted += res.filter((r) => r.isNew).length;
      }

      const [prev] = await tx
        .select({ attempts: collectionUnit.attempts })
        .from(collectionUnit)
        .where(
          and(
            eq(collectionUnit.runId, run.id),
            eq(collectionUnit.kind, input.kind),
            eq(collectionUnit.unitKey, input.unitKey),
            eq(collectionUnit.page, 1),
          ),
        );
      const attempts = (prev?.attempts ?? 0) + 1;
      const unitValues = {
        status: input.status,
        itemsFound: valid.length,
        itemsNew: inserted,
        errorCode,
        fetchedAt: fetched,
        attempts,
        bytesReceived: input.bytesReceived,
      };
      await tx
        .insert(collectionUnit)
        .values({ runId: run.id, kind: input.kind, unitKey: input.unitKey, page: 1, ...unitValues })
        .onConflictDoUpdate({
          target: [
            collectionUnit.runId,
            collectionUnit.kind,
            collectionUnit.unitKey,
            collectionUnit.page,
          ],
          set: unitValues,
        });

      const checkpoint =
        input.checkpoint && typeof input.checkpoint === "object" ? input.checkpoint : null;
      await tx
        .update(collectionRun)
        .set({
          requestsMade: input.requestsMade,
          bytesDownloaded,
          ...(checkpoint ? { checkpoint } : {}),
        })
        .where(eq(collectionRun.id, run.id));
      return {
        inserted,
        seenAgain: valid.length - inserted,
        rejected,
        rejectedByCode,
        requestsMade: input.requestsMade,
        bytesDownloaded,
      };
    });
  } catch (error) {
    throw collectionErrorFrom(error) ?? error;
  }
}

export interface DiscoveryProgress {
  uniqueProducts: number;
  byPriceState: Record<string, number>;
  unitsByStatus: Record<string, number>;
  bytesDownloaded: number;
  approvedBytes: number;
  maxBytes: number;
  transferOrigin: string;
  /** Kesfedilen kimlik sayisidir; katalog tamamlanma yuzdesi DEGILDIR. */
  note: string;
}

/** Kosu ilerlemesi. Benzersiz urun sayisi kaynak bazlidir; sabit hedef/yuzde yoktur. */
export async function discoveryProgress(
  db: Database,
  actor: AdminActor,
  input: { source: string; runId: number },
): Promise<DiscoveryProgress> {
  assertCapability(actor, "catalog.write");
  const [run] = await db.select().from(collectionRun).where(eq(collectionRun.id, input.runId));
  if (!run || run.source !== input.source) throw new CollectionError("bad_run");
  const states = await db
    .select({ s: catalogDiscovery.priceState, n: sql<number>`count(*)::int` })
    .from(catalogDiscovery)
    .where(eq(catalogDiscovery.source, input.source))
    .groupBy(catalogDiscovery.priceState);
  const units = await db
    .select({ s: collectionUnit.status, n: sql<number>`count(*)::int` })
    .from(collectionUnit)
    .where(eq(collectionUnit.runId, input.runId))
    .groupBy(collectionUnit.status);
  return {
    uniqueProducts: states.reduce((s, r) => s + r.n, 0),
    byPriceState: Object.fromEntries(states.map((r) => [r.s, r.n])),
    unitsByStatus: Object.fromEntries(units.map((r) => [r.s, r.n])),
    bytesDownloaded: run.bytesDownloaded,
    approvedBytes: run.downloadApprovedBytes,
    maxBytes: run.maxBytes,
    transferOrigin: run.transferOrigin,
    note: "Kesfedilen benzersiz kimlik sayisi; kaynagin tum katalogunu temsil ettigi kanitlanmamistir.",
  };
}
