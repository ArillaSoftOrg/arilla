/**
 * Askida kalan ayirmalarin DURUM-BILGILI uzlasmasi (docs/decisions/0046
 * madde 8). Yas tek basina iade sebebi degildir; bagli kayda bakilir:
 *
 * Link aramasi (`link_resolution_request`):
 *   resolved                                   -> kesinlestir
 *   failed                                     -> iade
 *   queued/processing, `IN_FLIGHT_TTL_MS`'ten eski -> iade ('link_stale').
 *     Bu, link aramasinin mevcut "olu is" politikasidir: o yastaki is yeniden
 *     kullanilmaz, ustune yeni istek acilir. Sonradan cozulurse kullanici
 *     sonucu ucretsiz almis olur; hak iki kez hareket etmez.
 *   queued/processing, daha yeni               -> dokunulmaz
 *
 * Fotograf aramasi (`image_upload`, senkron Server Action):
 *   embedded                                   -> kesinlestir
 *   diger / baglanti yok, `SYNC_RESERVATION_STALE_MS`'ten eski -> iade.
 *     Senkron istek bu sureyi asamaz (fonksiyon zaman asimi cok daha kisa);
 *     asmissa surec saglayici sonucunu yazamadan olmustur.
 *
 * Gecisler `settleCharge`/`refundCharge`'in kosullu UPDATE'i ile tam bir
 * kezdir; esanli iki uzlasma ayni harcamayi ikinci kez hareket ettiremez.
 */
import { type Database, imageUpload, linkResolutionRequest } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { IN_FLIGHT_TTL_MS } from "../discovery/link-resolution.ts";
import {
  type ChargeRecord,
  getCharge,
  type ReserveSearchInput,
  type ReserveSearchResult,
  refundCharge,
  reserveSearch,
  settleCharge,
} from "./charge.ts";
import { rows } from "./db.ts";

/** Senkron (fotograf) ayirmanin olu sayildigi yas. */
export const SYNC_RESERVATION_STALE_MS = 10 * 60 * 1000;

export type ReconcileOutcome = "settled" | "refunded" | "pending";

async function finalState(db: Database, chargeId: string): Promise<ReconcileOutcome> {
  const current = await getCharge(db, chargeId);
  if (!current || current.state === "reserved") return "pending";
  return current.state;
}

export async function reconcileCharge(
  db: Database,
  charge: ChargeRecord,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  if (charge.state !== "reserved") return charge.state;
  const age = now.getTime() - charge.createdAt.getTime();

  if (charge.operation === "visual_search") {
    if (charge.imageUploadId !== null) {
      const [upload] = await db
        .select({ status: imageUpload.status })
        .from(imageUpload)
        .where(eq(imageUpload.id, charge.imageUploadId))
        .limit(1);
      if (upload?.status === "embedded") {
        await settleCharge(db, charge.id);
        return finalState(db, charge.id);
      }
    }
    if (age <= SYNC_RESERVATION_STALE_MS) return "pending";
    await refundCharge(db, charge.id, "internal_error");
    return finalState(db, charge.id);
  }

  if (charge.linkRequestId === null) {
    if (age <= SYNC_RESERVATION_STALE_MS) return "pending";
    await refundCharge(db, charge.id, "internal_error");
    return finalState(db, charge.id);
  }

  const [request] = await db
    .select({
      status: linkResolutionRequest.status,
      errorCode: linkResolutionRequest.errorCode,
      createdAt: linkResolutionRequest.createdAt,
    })
    .from(linkResolutionRequest)
    .where(eq(linkResolutionRequest.id, charge.linkRequestId))
    .limit(1);
  if (!request) {
    if (age <= SYNC_RESERVATION_STALE_MS) return "pending";
    await refundCharge(db, charge.id, "internal_error");
    return finalState(db, charge.id);
  }

  if (request.status === "resolved") {
    await settleCharge(db, charge.id);
  } else if (request.status === "failed") {
    await refundCharge(
      db,
      charge.id,
      request.errorCode === "queue_unavailable" ? "queue_unavailable" : "link_failed",
    );
  } else if (now.getTime() - request.createdAt.getTime() > IN_FLIGHT_TTL_MS) {
    await refundCharge(db, charge.id, "link_stale");
  } else {
    return "pending";
  }
  return finalState(db, charge.id);
}

/**
 * `reserveSearch`; `busy` ise aktif harcamayi uzlastirir ve bitmisse bir kez
 * daha dener. Aktif arama gercekten suruyorsa `busy` doner.
 */
export async function reserveSearchReconciling(
  db: Database,
  input: ReserveSearchInput,
): Promise<ReserveSearchResult> {
  const first = await reserveSearch(db, input);
  if (first.status !== "busy") return first;
  const outcome = await reconcileCharge(db, first.active, input.now);
  if (outcome === "pending") return first;
  return reserveSearch(db, input);
}

/** Link durum sorgusundan: bu istege bagli ayirma varsa uzlastirir. */
export async function reconcileLinkRequestCharge(
  db: Database,
  linkRequestId: string,
  now: Date = new Date(),
): Promise<ReconcileOutcome | null> {
  const [row] = await rows<{ id: string }>(
    db,
    sql`
      SELECT id FROM ai_search_charge
       WHERE link_request_id = ${linkRequestId} AND state = 'reserved'
    `,
  );
  if (!row) return null;
  const charge = await getCharge(db, row.id);
  return charge ? reconcileCharge(db, charge, now) : null;
}

export interface ReconcileSweepResult {
  settled: number;
  refunded: number;
  pending: number;
}

/**
 * Gunluk guvenlik agi (`/api/cron/cleanup-auth`). Yalnizca `IN_FLIGHT_TTL_MS`
 * yasini gecmis ayirmalara bakar; her biri durum-bilgili uzlasmadan gecer.
 */
export async function reconcileStaleCharges(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<ReconcileSweepResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - IN_FLIGHT_TTL_MS);
  const candidates = await rows<{ id: string }>(
    db,
    sql`
      SELECT id FROM ai_search_charge
       WHERE state = 'reserved' AND created_at < ${cutoff.toISOString()}::timestamptz
       ORDER BY created_at
       LIMIT ${options.limit ?? 500}
    `,
  );
  const result: ReconcileSweepResult = { settled: 0, refunded: 0, pending: 0 };
  for (const candidate of candidates) {
    const charge = await getCharge(db, candidate.id);
    if (!charge) continue;
    result[await reconcileCharge(db, charge, now)]++;
  }
  return result;
}
