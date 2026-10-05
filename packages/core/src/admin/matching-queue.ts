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
import { and, asc, count, desc, eq, inArray, isNotNull, lt, ne, type SQL, sql } from "drizzle-orm";
import { maskEmail, recordAdminEvent } from "./audit.ts";
import { clampPageSize, isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import {
  type EvidenceSignal,
  explainSignals,
  humanReviewReasons,
  type IdentifierCheck,
  identifierAgreement,
  type ScoreBand,
  scoreBand,
} from "./match-evidence.ts";
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

/** Adaya zaten bağlı aktif teklif (karar 0053): moderatörün karşılaştırma kanıtı. */
export interface MatchSiblingOffer {
  offerId: number;
  merchantId: number;
  merchantName: string;
  merchantActive: boolean;
  /** Kuruş. */
  price: number | null;
  inStock: boolean;
  gtin: string | null;
  mpn: string | null;
  /** Varyant barkodları, teklif başına en çok `SIBLING_VARIANT_GTINS`. */
  variantGtins: string[];
}

/**
 * Kuyruk satırının kanıtı. Kanıt sorgusu zaman aşımına uğrarsa
 * `evidenceAvailable: false` olur; kardeş/kimlik bilgisi "yok" sayılmaz.
 */
export interface MatchEvidence {
  band: ScoreBand;
  signals: EvidenceSignal[];
  humanReasons: string[];
  evidenceAvailable: boolean;
  identifiers: { gtin: IdentifierCheck; mpn: IdentifierCheck } | null;
  siblings: MatchSiblingOffer[];
  /** Adaya bağlı aktif teklif sayısı (canlı, fiyat özetinden bağımsız). */
  siblingTotal: number | null;
  /** Aktif tekliflerin şu anki en düşük fiyatı (kuruş, canlı). */
  liveMinPrice: number | null;
  /**
   * Adaya bağlı bir teklif kuyruktaki teklifle AYNI mağazada. Resolver
   * metin/görsel yolunda bu adayı bugün önermez (pipeline.SAME_MERCHANT_PRODUCTS).
   */
  sameMerchantSibling: boolean;
}

export interface MatchQueueItem {
  matchCandidateId: number;
  score: number;
  method: MatchMethod;
  explain: MatchExplain | null;
  /** `match_candidate.created_at`: kuyrukta bekleme başlangıcı. */
  createdAt: Date;
  evidence: MatchEvidence;
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
/** Aday başına gösterilen kardeş teklif (karar 0053). */
export const SIBLINGS_PER_PRODUCT = 8;
const SIBLING_VARIANT_GTINS = 12;
/** Aday başına okunan farklı barkod/MPN üst sınırı. */
const CANDIDATE_GTINS_MAX = 200;
const CANDIDATE_MPNS_MAX = 20;
/** Kanıt sorguları bu süreyi aşarsa kuyruk kanıtsız açılır (karar verilebilir kalır). */
const EVIDENCE_TIMEOUT_MS = 3_000;

interface ProductEvidenceRaw {
  siblings: MatchSiblingOffer[];
  siblingTotal: number;
  liveMinPrice: number | null;
  gtins: string[];
  gtinSetComplete: boolean;
  mpns: string[];
  merchantIds: number[];
}

function emptyEvidence(): ProductEvidenceRaw {
  return {
    siblings: [],
    siblingTotal: 0,
    liveMinPrice: null,
    gtins: [],
    gtinSetComplete: false,
    mpns: [],
    merchantIds: [],
  };
}

/**
 * Bir gruptaki TÜM aday ürünler için iki sorgu (N+1 yok): kardeş teklifler
 * (ürün başına en çok 8; varyant barkodu teklif başına en çok 12) ve
 * resolver'ın `identifiers.CANDIDATE_GTIN_SETS` sorgusunun aynısı (aktif
 * tekliflerin barkod kümesi + kümenin tam olup olmadığı). `offer_product_idx`
 * ve `offer_variant_uniq (offer_id, …)` kullanılır; salt okunur, zaman aşımlı.
 * Hata/zaman aşımında `null`: kuyruk kanıtsız açılır.
 */
async function loadProductEvidence(
  db: Database,
  productIds: number[],
): Promise<Map<number, ProductEvidenceRaw> | null> {
  if (productIds.length === 0) return new Map();
  const ids = sql.join(
    productIds.map((id) => sql`${id}`),
    sql`, `,
  );
  try {
    return await readOnly(db, EVIDENCE_TIMEOUT_MS, async (tx) => {
      const siblings = await tx.execute<{
        product_id: string;
        id: string;
        merchant_id: string;
        merchant_name: string;
        merchant_active: boolean;
        current_price: string | null;
        in_stock: boolean;
        gtin: string | null;
        mpn: string | null;
        total: string;
        live_min: string | null;
        variant_gtins: string[] | null;
      }>(sql`
        SELECT s.product_id, s.id, s.merchant_id, s.merchant_name, s.merchant_active,
               s.current_price, s.in_stock, s.gtin, s.mpn, s.total, s.live_min,
               ARRAY(SELECT v.gtin FROM offer_variant v
                      WHERE v.offer_id = s.id AND v.gtin IS NOT NULL
                      ORDER BY v.id LIMIT ${SIBLING_VARIANT_GTINS}) AS variant_gtins
          FROM (
            SELECT o.product_id, o.id, o.merchant_id, m.name AS merchant_name,
                   m.is_active AS merchant_active, o.current_price, o.in_stock,
                   o.attributes_raw->>'gtin' AS gtin, o.attributes_raw->>'mpn' AS mpn,
                   row_number() OVER (PARTITION BY o.product_id
                                      ORDER BY o.current_price ASC NULLS LAST, o.id) AS rn,
                   count(*) OVER (PARTITION BY o.product_id) AS total,
                   min(o.current_price) OVER (PARTITION BY o.product_id) AS live_min
              FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE o.product_id IN (${ids}) AND o.is_active
          ) s
         WHERE s.rn <= ${SIBLINGS_PER_PRODUCT}
         ORDER BY s.product_id, s.rn
      `);
      const sets = await tx.execute<{
        product_id: string;
        gtins: string[] | null;
        complete: boolean | null;
        mpns: string[] | null;
        merchant_ids: string[] | null;
      }>(sql`
        SELECT o.product_id,
               (array_remove(array_agg(DISTINCT COALESCE(ov.gtin, o.attributes_raw->>'gtin')), NULL))[1:${CANDIDATE_GTINS_MAX}] AS gtins,
               bool_and(COALESCE(ov.gtin, o.attributes_raw->>'gtin') IS NOT NULL) AS complete,
               (array_remove(array_agg(DISTINCT o.attributes_raw->>'mpn'), NULL))[1:${CANDIDATE_MPNS_MAX}] AS mpns,
               (array_agg(DISTINCT o.merchant_id))[1:${CANDIDATE_GTINS_MAX}] AS merchant_ids
          FROM offer o
          LEFT JOIN offer_variant ov ON ov.offer_id = o.id
         WHERE o.product_id IN (${ids}) AND o.is_active
         GROUP BY o.product_id
      `);

      const out = new Map<number, ProductEvidenceRaw>();
      const entry = (productId: number): ProductEvidenceRaw => {
        const existing = out.get(productId);
        if (existing) return existing;
        const created = emptyEvidence();
        out.set(productId, created);
        return created;
      };
      for (const row of siblings.rows) {
        const e = entry(Number(row.product_id));
        e.siblingTotal = Number(row.total);
        e.liveMinPrice = row.live_min === null ? null : Number(row.live_min);
        e.siblings.push({
          offerId: Number(row.id),
          merchantId: Number(row.merchant_id),
          merchantName: row.merchant_name,
          merchantActive: row.merchant_active,
          price: row.current_price === null ? null : Number(row.current_price),
          inStock: row.in_stock,
          gtin: row.gtin ? row.gtin.slice(0, 64) : null,
          mpn: row.mpn ? row.mpn.slice(0, 64) : null,
          variantGtins: (row.variant_gtins ?? []).map((g) => g.slice(0, 64)),
        });
      }
      for (const row of sets.rows) {
        const e = entry(Number(row.product_id));
        e.gtins = row.gtins ?? [];
        e.gtinSetComplete = row.complete === true;
        e.mpns = row.mpns ?? [];
        e.merchantIds = (row.merchant_ids ?? []).map(Number);
      }
      return out;
    });
  } catch {
    return null;
  }
}

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
      createdAt: matchCandidate.createdAt,
      offerId: offer.id,
      offerMerchantId: offer.merchantId,
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

  const productEvidence = await loadProductEvidence(db, [
    ...new Set(rows.map((row) => row.productId)),
  ]);

  return rows.map((row) => {
    const offerAttributes = (row.offerAttributes ?? {}) as Record<string, unknown>;
    const explain = (row.explain ?? null) as MatchExplain | null;
    const offerVariants = variantsByOffer.get(row.offerId) ?? [];
    const offerGtin = stringAttr(offerAttributes, "gtin");
    const offerMpn = stringAttr(offerAttributes, "mpn");
    const evidenceAvailable = productEvidence !== null;
    const raw = productEvidence?.get(row.productId) ?? emptyEvidence();
    return {
      matchCandidateId: row.matchCandidateId,
      score: row.score,
      method: row.method,
      explain,
      createdAt: row.createdAt,
      evidence: {
        band: scoreBand(row.score, explain),
        signals: explainSignals(row.method, row.score, explain),
        humanReasons: humanReviewReasons(row.method, row.score, explain),
        evidenceAvailable,
        identifiers: evidenceAvailable
          ? identifierAgreement({
              offer: {
                gtin: offerGtin,
                mpn: offerMpn,
                variantGtins: offerVariants
                  .map((v) => v.gtin)
                  .filter((g): g is string => g !== null),
              },
              product: { gtin: row.productGtin, mpn: row.productMpn },
              candidateGtins: raw.gtins,
              candidateGtinSetComplete: raw.gtinSetComplete,
              siblingMpns: raw.mpns,
            })
          : null,
        siblings: raw.siblings,
        siblingTotal: evidenceAvailable ? raw.siblingTotal : null,
        liveMinPrice: raw.liveMinPrice,
        sameMerchantSibling: raw.merchantIds.includes(row.offerMerchantId),
      },
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
        gtin: offerGtin,
        mpn: offerMpn,
        variants: offerVariants,
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
