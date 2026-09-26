/**
 * `/yonetim/eslestirme` kuyruğu (docs/pages.md). Skoru
 * `MATCH_QUEUE_THRESHOLD` (0.63) ile `MATCH_AUTO_ACCEPT_THRESHOLD` (0.84)
 * arasında kalan `match_candidate` satırları insan onayı bekler
 * (docs/decisions/0017).
 *
 * Onay, `services/ingest/resolve/pipeline.py`'nin `auto_accepted` yolunun
 * (LINK_OFFER: `offer.product_id` bağlama) insan tetikli aynısıdır — ikisi
 * de aynı etkiyi üretir, biri eşik üstü otomatik, diğeri insan kararıyla.
 *
 * Faz 3 (docs/decisions/0041): filtreler, zengin kimlik bilgisi (GTIN/MPN,
 * varyant SKU/GTIN, fiyat), skor açıklaması (`explain`), red nedeni ve
 * inceleme geçmişi. Eşikler ve karar mantığı değişmez.
 */

import {
  appUser,
  brand,
  type Database,
  matchCandidate,
  merchant,
  offer,
  offerVariant,
  product,
} from "@arilla/db";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, ne, type SQL } from "drizzle-orm";
import { maskEmail, recordAdminEvent } from "./audit.ts";
import { clampPageSize, isPositiveId } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { httpUrl, safeUrl } from "./redact.ts";

export type MatchMethod = "gtin" | "mpn" | "text" | "image" | "hybrid";
export const MATCH_METHODS: readonly MatchMethod[] = ["gtin", "mpn", "text", "image", "hybrid"];

export function isMatchMethod(value: unknown): value is MatchMethod {
  return typeof value === "string" && (MATCH_METHODS as readonly string[]).includes(value);
}

/** İnsanın seçebileceği red nedenleri. `superseded` yalnızca onay yazar. */
export const REVIEW_REASONS = [
  "not_same_product",
  "different_color",
  "different_size",
  "bad_data",
  "other",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export function isReviewReason(value: unknown): value is ReviewReason {
  return typeof value === "string" && (REVIEW_REASONS as readonly string[]).includes(value);
}

export interface MatchVariantInfo {
  sizeLabel: string | null;
  sku: string | null;
  gtin: string | null;
  gtinSource: string | null;
  inStock: boolean;
}

/** `match_candidate.explain` (resolver, 0028). Eski satırlarda yok. */
export interface MatchExplain {
  method?: string;
  score?: number;
  text_similarity?: number;
  review?: string | null;
  auto_eligible?: boolean;
  brand_known_both?: boolean;
  brand_equal?: boolean;
  queue_threshold?: number;
  auto_accept_threshold?: number;
}

export interface MatchQueueItem {
  matchCandidateId: number;
  score: number;
  method: MatchMethod;
  explain: MatchExplain | null;
  offer: {
    id: number;
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
    merchantId: number;
    merchantName: string;
    /** Kuruş. */
    price: number | null;
    currency: string;
    inStock: boolean;
    /** Sorgu dizisi olmadan; tıklanabilir çıkış değil (kural 8), kopyalanabilir metin. */
    url: string | null;
    gtin: string | null;
    mpn: string | null;
    variants: MatchVariantInfo[];
  };
  product: {
    id: number;
    slug: string;
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
    gtin: string | null;
    mpn: string | null;
    minPrice: number | null;
    offerCount: number;
  };
}

export interface MatchQueueFilter {
  method?: MatchMethod;
  merchantId?: number;
}

/** Varyant listesi teklif başına sınırlı: kuyruk kartı bir envanter dökümü değil. */
const VARIANTS_PER_OFFER = 12;

function pendingConditions(filter: MatchQueueFilter): SQL[] {
  const conditions: SQL[] = [eq(matchCandidate.status, "pending")];
  if (isMatchMethod(filter.method)) conditions.push(eq(matchCandidate.method, filter.method));
  if (isPositiveId(filter.merchantId)) conditions.push(eq(offer.merchantId, filter.merchantId));
  return conditions;
}

/** Kuyruğun gerçek toplamı (sayfadaki grup değil). `match_candidate_pending_idx` kısmi indeksi. */
export async function countPendingMatches(
  db: Database,
  filter: MatchQueueFilter = {},
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(matchCandidate)
    .innerJoin(offer, eq(offer.id, matchCandidate.offerId))
    .where(and(...pendingConditions(filter)));
  return rows[0]?.n ?? 0;
}

/** Filtre seçenekleri: bekleyen adayı olan mağazalar. */
export async function listPendingMatchMerchants(
  db: Database,
): Promise<{ id: number; name: string; pending: number }[]> {
  return db
    .select({ id: merchant.id, name: merchant.name, pending: count() })
    .from(matchCandidate)
    .innerJoin(offer, eq(offer.id, matchCandidate.offerId))
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .where(eq(matchCandidate.status, "pending"))
    .groupBy(merchant.id, merchant.name)
    .orderBy(asc(merchant.name))
    .limit(200);
}

function stringAttr(attributes: Record<string, unknown>, key: string): string | null {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value.slice(0, 64) : null;
}

/** pages.md: "Kuyruk skora göre sıralanır, en belirsizler önce gelir." */
export async function listMatchQueue(
  db: Database,
  limit = 20,
  filter: MatchQueueFilter = {},
): Promise<MatchQueueItem[]> {
  const rows = await db
    .select({
      matchCandidateId: matchCandidate.id,
      score: matchCandidate.score,
      method: matchCandidate.method,
      explain: matchCandidate.explain,
      offerId: offer.id,
      offerTitle: offer.titleRaw,
      offerBrand: offer.brandRaw,
      offerImageUrl: offer.imageUrl,
      offerAttributes: offer.attributesRaw,
      offerPrice: offer.currentPrice,
      offerCurrency: offer.currency,
      offerInStock: offer.inStock,
      offerUrl: offer.url,
      merchantId: merchant.id,
      merchantName: merchant.name,
      productId: product.id,
      productSlug: product.slug,
      productTitle: product.title,
      productBrand: brand.name,
      productImageUrl: product.primaryImageUrl,
      productAttributes: product.attributes,
      productGtin: product.gtin,
      productMpn: product.mpn,
      productMinPrice: product.minPrice,
      productOfferCount: product.offerCount,
    })
    .from(matchCandidate)
    .innerJoin(offer, eq(offer.id, matchCandidate.offerId))
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .innerJoin(product, eq(product.id, matchCandidate.productId))
    .leftJoin(brand, eq(brand.id, product.brandId))
    .where(and(...pendingConditions(filter)))
    .orderBy(asc(matchCandidate.score), asc(matchCandidate.id))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 100));

  const offerIds = [...new Set(rows.map((row) => row.offerId))];
  const variantRows =
    offerIds.length > 0
      ? await db
          .select({
            offerId: offerVariant.offerId,
            sizeLabel: offerVariant.sizeLabel,
            sku: offerVariant.sku,
            gtin: offerVariant.gtin,
            gtinSource: offerVariant.gtinSource,
            inStock: offerVariant.inStock,
          })
          .from(offerVariant)
          .where(inArray(offerVariant.offerId, offerIds))
          .orderBy(asc(offerVariant.offerId), asc(offerVariant.id))
          .limit(offerIds.length * VARIANTS_PER_OFFER)
      : [];
  const variantsByOffer = new Map<number, MatchVariantInfo[]>();
  for (const { offerId, ...variant } of variantRows) {
    const list = variantsByOffer.get(offerId) ?? [];
    if (list.length < VARIANTS_PER_OFFER) list.push(variant);
    variantsByOffer.set(offerId, list);
  }

  return rows.map((row) => {
    const offerAttributes = (row.offerAttributes ?? {}) as Record<string, unknown>;
    return {
      matchCandidateId: row.matchCandidateId,
      score: row.score,
      method: row.method,
      explain: (row.explain ?? null) as MatchExplain | null,
      offer: {
        id: row.offerId,
        title: row.offerTitle,
        brand: row.offerBrand,
        imageUrl: httpUrl(row.offerImageUrl),
        attributes: offerAttributes,
        merchantId: row.merchantId,
        merchantName: row.merchantName,
        price: row.offerPrice,
        currency: row.offerCurrency,
        inStock: row.offerInStock,
        url: safeUrl(row.offerUrl),
        gtin: stringAttr(offerAttributes, "gtin"),
        mpn: stringAttr(offerAttributes, "mpn"),
        variants: variantsByOffer.get(row.offerId) ?? [],
      },
      product: {
        id: row.productId,
        slug: row.productSlug,
        title: row.productTitle,
        brand: row.productBrand,
        imageUrl: httpUrl(row.productImageUrl),
        attributes: (row.productAttributes ?? {}) as Record<string, unknown>,
        gtin: row.productGtin,
        mpn: row.productMpn,
        minPrice: row.productMinPrice,
        offerCount: row.productOfferCount,
      },
    };
  });
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
 * `rejected`/`superseded` olur (bir teklif tek ürüne bağlanır; onlar artık
 * geçersiz) ve denetim kaydı yazılır.
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
      .set({ status: "accepted", reviewedBy: actor.userId, reviewedAt, reviewReason: null })
      .where(eq(matchCandidate.id, matchCandidateId));
    await tx.update(offer).set({ productId: row.productId }).where(eq(offer.id, row.offerId));

    const superseded = await tx
      .update(matchCandidate)
      .set({
        status: "rejected",
        reviewedBy: actor.userId,
        reviewedAt,
        reviewReason: "superseded",
      })
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

export class ReviewReasonError extends Error {
  constructor() {
    super("Geçersiz red nedeni.");
    this.name = "ReviewReasonError";
  }
}

/**
 * Reddet — yalnızca durum (ve varsa neden) değişir, `offer.product_id`'ye
 * dokunulmaz. Reddedilen çift resolver tarafından bir daha önerilmez (0040).
 */
export async function rejectMatch(
  db: Database,
  actor: AdminActor,
  matchCandidateId: number,
  reason: ReviewReason | null = null,
): Promise<ReviewResult> {
  assertCapability(actor, "matching.review");
  if (reason !== null && !isReviewReason(reason)) throw new ReviewReasonError();

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(matchCandidate)
      .set({
        status: "rejected",
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason: reason,
      })
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
      after: {
        status: "rejected",
        offerId: row.offerId,
        productId: row.productId,
        reviewReason: reason,
      },
      reason,
    });
    return { found: true };
  });
}

export interface MatchHistoryRow {
  matchCandidateId: number;
  status: "accepted" | "rejected";
  reviewReason: string | null;
  reviewedAt: Date | null;
  reviewerId: number | null;
  /** Maskeli e-posta ya da `#<id>`. */
  reviewerLabel: string | null;
  score: number;
  method: MatchMethod;
  offerId: number;
  offerTitle: string;
  merchantName: string;
  productId: number;
  productSlug: string;
  productTitle: string;
}

export interface MatchHistoryFilter {
  status?: "accepted" | "rejected";
  reason?: string;
  beforeId?: number;
  pageSize?: number;
}

/**
 * İnsan kararları (`reviewed_by` dolu). `auto_accepted` satırlar burada
 * değil: onlar makine kararıdır.
 */
export async function listMatchHistory(
  db: Database,
  actor: AdminActor,
  filter: MatchHistoryFilter = {},
): Promise<{ rows: MatchHistoryRow[]; nextBeforeId: number | null }> {
  assertCapability(actor, "matching.review");
  const pageSize = clampPageSize(filter.pageSize);
  const conditions: SQL[] = [isNotNull(matchCandidate.reviewedBy)];
  if (filter.status === "accepted" || filter.status === "rejected") {
    conditions.push(eq(matchCandidate.status, filter.status));
  }
  if (isReviewReason(filter.reason) || filter.reason === "superseded") {
    conditions.push(eq(matchCandidate.reviewReason, filter.reason));
  }
  if (isPositiveId(filter.beforeId)) conditions.push(lt(matchCandidate.id, filter.beforeId));

  const rows = await db
    .select({
      matchCandidateId: matchCandidate.id,
      status: matchCandidate.status,
      reviewReason: matchCandidate.reviewReason,
      reviewedAt: matchCandidate.reviewedAt,
      reviewerId: matchCandidate.reviewedBy,
      reviewerEmail: appUser.email,
      score: matchCandidate.score,
      method: matchCandidate.method,
      offerId: offer.id,
      offerTitle: offer.titleRaw,
      merchantName: merchant.name,
      productId: product.id,
      productSlug: product.slug,
      productTitle: product.title,
    })
    .from(matchCandidate)
    .innerJoin(offer, eq(offer.id, matchCandidate.offerId))
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .innerJoin(product, eq(product.id, matchCandidate.productId))
    .leftJoin(appUser, eq(appUser.id, matchCandidate.reviewedBy))
    .where(and(...conditions))
    .orderBy(desc(matchCandidate.id))
    .limit(pageSize + 1);

  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    rows: page.map(({ reviewerEmail, status, ...row }) => ({
      ...row,
      status: status === "accepted" ? "accepted" : "rejected",
      reviewerLabel:
        row.reviewerId === null ? null : (maskEmail(reviewerEmail) ?? `#${row.reviewerId}`),
    })),
    nextBeforeId: rows.length > pageSize && last ? last.matchCandidateId : null,
  };
}
