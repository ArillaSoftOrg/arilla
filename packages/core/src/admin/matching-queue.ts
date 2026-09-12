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
import { and, asc, eq } from "drizzle-orm";

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
}

/** Onayla — `match_candidate.status='accepted'` ve `offer.product_id` aynı işlemde yazılır. */
export function approveMatch(db: Database, matchCandidateId: number): Promise<ReviewResult> {
  return reviewMatch(db, matchCandidateId, "accepted");
}

/** Reddet — yalnızca durum değişir, `offer.product_id`'ye dokunulmaz. */
export function rejectMatch(db: Database, matchCandidateId: number): Promise<ReviewResult> {
  return reviewMatch(db, matchCandidateId, "rejected");
}

async function reviewMatch(
  db: Database,
  matchCandidateId: number,
  status: "accepted" | "rejected",
): Promise<ReviewResult> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(matchCandidate)
      .set({ status, reviewedAt: new Date() })
      .where(and(eq(matchCandidate.id, matchCandidateId), eq(matchCandidate.status, "pending")))
      .returning({ offerId: matchCandidate.offerId, productId: matchCandidate.productId });

    const row = updated[0];
    if (!row) return { found: false };

    if (status === "accepted") {
      await tx.update(offer).set({ productId: row.productId }).where(eq(offer.id, row.offerId));
    }
    return { found: true };
  });
}
