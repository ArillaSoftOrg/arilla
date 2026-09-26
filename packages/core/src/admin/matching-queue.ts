/**
 * `/yonetim/eslestirme` kuyruğu (docs/pages.md). Skoru
 * `MATCH_QUEUE_THRESHOLD` (0.63) ile `MATCH_AUTO_ACCEPT_THRESHOLD` (0.84)
 * arasında kalan `match_candidate` satırları insan onayı bekler
 * (docs/decisions/0017).
 *
 * Onay, `services/ingest/resolve/pipeline.py`'nin `auto_accepted` yolunun
 * (LINK_OFFER: `offer.product_id` bağlama) insan tetikli aynısıdır — ikisi
 * de aynı etkiyi üretir, biri eşik üstü otomatik, diğeri insan kararıyla.
 */

import { brand, type Database, matchCandidate, merchant, offer, product } from "@arilla/db";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { recordAdminEvent } from "./audit.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export interface MatchQueueItem {
  matchCandidateId: number;
  score: number;
  method: "gtin" | "mpn" | "text" | "image" | "hybrid";
  offer: {
    id: number;
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
    merchantName: string;
  };
  product: {
    id: number;
    slug: string;
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
  };
}

/** Kuyruğun gerçek toplamı (sayfadaki grup değil). `match_candidate_pending_idx` kısmi indeksi. */
export async function countPendingMatches(db: Database): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(matchCandidate)
    .where(eq(matchCandidate.status, "pending"));
  return rows[0]?.n ?? 0;
}

/** pages.md: "Kuyruk skora göre sıralanır, en belirsizler önce gelir." */
export async function listMatchQueue(db: Database, limit = 20): Promise<MatchQueueItem[]> {
  const rows = await db
    .select({
      matchCandidateId: matchCandidate.id,
      score: matchCandidate.score,
      method: matchCandidate.method,
      offerId: offer.id,
      offerTitle: offer.titleRaw,
      offerBrand: offer.brandRaw,
      offerImageUrl: offer.imageUrl,
      offerAttributes: offer.attributesRaw,
      merchantName: merchant.name,
      productId: product.id,
      productSlug: product.slug,
      productTitle: product.title,
      productBrand: brand.name,
      productImageUrl: product.primaryImageUrl,
      productAttributes: product.attributes,
    })
    .from(matchCandidate)
    .innerJoin(offer, eq(offer.id, matchCandidate.offerId))
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .innerJoin(product, eq(product.id, matchCandidate.productId))
    .leftJoin(brand, eq(brand.id, product.brandId))
    .where(eq(matchCandidate.status, "pending"))
    .orderBy(asc(matchCandidate.score), asc(matchCandidate.id))
    .limit(limit);

  return rows.map((row) => ({
    matchCandidateId: row.matchCandidateId,
    score: row.score,
    method: row.method,
    offer: {
      id: row.offerId,
      title: row.offerTitle,
      brand: row.offerBrand,
      imageUrl: row.offerImageUrl,
      attributes: (row.offerAttributes ?? {}) as Record<string, unknown>,
      merchantName: row.merchantName,
    },
    product: {
      id: row.productId,
      slug: row.productSlug,
      title: row.productTitle,
      brand: row.productBrand,
      imageUrl: row.productImageUrl,
      attributes: (row.productAttributes ?? {}) as Record<string, unknown>,
    },
  }));
}

export interface ReviewResult {
  /** false: satır zaten `pending` değildi (başka bir sekmede önceden karara bağlanmış). */
  found: boolean;
  /**
   * true: teklif bu arada BAŞKA bir ürüne bağlanmış (ör. aynı teklifin diğer
   * adayı onaylandı). Hiçbir şey değişmez; satır `pending` kalır.
   */
  conflict?: boolean;
}

/**
 * Onayla — aynı işlemde: `match_candidate.status='accepted'` + `reviewed_by`,
 * `offer.product_id` bağlanır, aynı teklifin diğer `pending` adayları
 * `rejected` olur (bir teklif tek ürüne bağlanır; onlar artık geçersiz) ve
 * denetim kaydı yazılır.
 *
 * Teklif zaten başka bir ürüne bağlıysa bağ EZİLMEZ: `conflict: true`.
 */
export async function approveMatch(
  db: Database,
  actor: AdminActor,
  matchCandidateId: number,
): Promise<ReviewResult> {
  assertCapability(actor, "matching.review");

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({
        offerId: matchCandidate.offerId,
        productId: matchCandidate.productId,
        linkedProductId: offer.productId,
      })
      .from(matchCandidate)
      .innerJoin(offer, eq(offer.id, matchCandidate.offerId))
      .where(and(eq(matchCandidate.id, matchCandidateId), eq(matchCandidate.status, "pending")))
      .for("update");

    const row = locked[0];
    if (!row) return { found: false };
    if (row.linkedProductId !== null && row.linkedProductId !== row.productId) {
      return { found: true, conflict: true };
    }

    const reviewedAt = new Date();
    await tx
      .update(matchCandidate)
      .set({ status: "accepted", reviewedBy: actor.userId, reviewedAt })
      .where(eq(matchCandidate.id, matchCandidateId));
    await tx.update(offer).set({ productId: row.productId }).where(eq(offer.id, row.offerId));

    const superseded = await tx
      .update(matchCandidate)
      .set({ status: "rejected", reviewedBy: actor.userId, reviewedAt })
      .where(
        and(
          eq(matchCandidate.offerId, row.offerId),
          eq(matchCandidate.status, "pending"),
          ne(matchCandidate.id, matchCandidateId),
        ),
      )
      .returning({ id: matchCandidate.id });

    await recordAdminEvent(tx, {
      actor,
      action: "matching.approve",
      targetType: "match_candidate",
      targetId: matchCandidateId,
      before: { status: "pending", offerProductId: row.linkedProductId },
      after: {
        status: "accepted",
        offerId: row.offerId,
        productId: row.productId,
        supersededCandidateIds: superseded.map((s) => s.id),
      },
    });
    return { found: true };
  });
}

/** Reddet — yalnızca durum değişir, `offer.product_id`'ye dokunulmaz. */
export async function rejectMatch(
  db: Database,
  actor: AdminActor,
  matchCandidateId: number,
): Promise<ReviewResult> {
  assertCapability(actor, "matching.review");

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(matchCandidate)
      .set({ status: "rejected", reviewedBy: actor.userId, reviewedAt: new Date() })
      .where(and(eq(matchCandidate.id, matchCandidateId), eq(matchCandidate.status, "pending")))
      .returning({ offerId: matchCandidate.offerId, productId: matchCandidate.productId });

    const row = updated[0];
    if (!row) return { found: false };

    await recordAdminEvent(tx, {
      actor,
      action: "matching.reject",
      targetType: "match_candidate",
      targetId: matchCandidateId,
      before: { status: "pending" },
      after: { status: "rejected", offerId: row.offerId, productId: row.productId },
    });
    return { found: true };
  });
}
