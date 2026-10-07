/**
 * `/yonetim/katalog` (Faz 4): ürün ve teklif inceleme. SALT OKUNUR — genel
 * bir tablo düzenleyici değildir; gizleme/düzeltme gibi mutasyonlar ayrı bir
 * karar gerektirir (docs/decisions/0039, "catalog.write" ileride).
 *
 * Her liste sayfalı ve zaman aşımlıdır. Başlık araması `product_title_fold_trgm`
 * indeksinin ifadesiyle (`foldedTitleExpr`) yapılır.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { foldedTitleExpr } from "../search/text-match.ts";
import { clampPage, clampPageSize, containsPattern, isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { httpUrl, safeUrl } from "./redact.ts";

export const PRODUCT_QUALITY_FILTERS = [
  "no_brand",
  "no_category",
  "no_image",
  "no_offers",
  "no_price",
  "stale_price",
] as const;
export type ProductQualityFilter = (typeof PRODUCT_QUALITY_FILTERS)[number];

export function isProductQualityFilter(value: unknown): value is ProductQualityFilter {
  return (
    typeof value === "string" && (PRODUCT_QUALITY_FILTERS as readonly string[]).includes(value)
  );
}

/**
 * Fiyat ÖZETİ (`price_updated_at`, `min_price`, `offer_count`) bu kadar gündür
 * yazılmamış ürün. Özet teklifi yazan işlemde yenilenir ve yalnızca değişince
 * yazılır (`product/refresh-aggregates.ts`); filtre mağaza fiyatının eskiliğini
 * değil özetin son değiştiği anı ölçer (karar 0051). Filtre anahtarı
 * (`stale_price`) adres uyumu için korunur.
 */
export const STALE_PRICE_DAYS = 7;

const QUALITY_SQL: Record<ProductQualityFilter, SQL> = {
  no_brand: sql`p.brand_id IS NULL`,
  no_category: sql`p.category_id IS NULL`,
  no_image: sql`p.primary_image_url IS NULL`,
  no_offers: sql`p.offer_count = 0`,
  no_price: sql`p.min_price IS NULL`,
  stale_price: sql`(p.price_updated_at IS NULL OR p.price_updated_at < now() - (${STALE_PRICE_DAYS} * interval '1 day'))`,
};

export interface ProductListRow {
  id: number;
  slug: string;
  title: string;
  brandName: string | null;
  categoryPath: string | null;
  imageUrl: string | null;
  gtin: string | null;
  minPrice: number | null;
  offerCount: number;
  inStockCount: number;
  priceUpdatedAt: Date | null;
}

/**
 * Katalog kalitesi bulgularının bağlandığı ek filtreler (karar 0053). Üst
 * paneldeki sayaçlara girmez (her ürün listesi açılışında ek tarama yok);
 * yalnızca `/yonetim/katalog/kalite` bağlantılarıyla kullanılır.
 */
export const PRODUCT_ISSUE_FILTERS = ["no_active_offer", "duplicate_gtin"] as const;
export type ProductIssueFilter = (typeof PRODUCT_ISSUE_FILTERS)[number];

export function isProductIssueFilter(value: unknown): value is ProductIssueFilter {
  return typeof value === "string" && (PRODUCT_ISSUE_FILTERS as readonly string[]).includes(value);
}

const ISSUE_SQL: Record<ProductIssueFilter, SQL> = {
  // Canlı: fiyat özetindeki `offer_count`a değil aktif teklif satırlarına bakar.
  no_active_offer: sql`NOT EXISTS (SELECT 1 FROM offer io WHERE io.product_id = p.id AND io.is_active)`,
  // `product_gtin_idx`
  duplicate_gtin: sql`(p.gtin IS NOT NULL AND EXISTS (
    SELECT 1 FROM product p2 WHERE p2.gtin = p.gtin AND p2.id <> p.id))`,
};

export interface ProductSearchFilter {
  /** Sayı → id; 8–14 hane → GTIN (ürün ya da varyant); diğer → başlık. */
  query?: string;
  quality?: ProductQualityFilter;
  issue?: ProductIssueFilter;
  page?: number;
}

export const CATALOG_PAGE_SIZE = 50;

type ProductRow = {
  id: string;
  slug: string;
  title: string;
  brand_name: string | null;
  category_path: string | null;
  primary_image_url: string | null;
  gtin: string | null;
  min_price: string | null;
  offer_count: number;
  in_stock_count: number;
  price_updated_at: string | null;
};

function queryCondition(query: string | undefined): SQL | null {
  const q = query?.trim() ?? "";
  if (!q) return null;
  if (/^#?\d{1,7}$/.test(q)) return sql`p.id = ${Number(q.replace("#", ""))}`;
  if (/^\d{8,14}$/.test(q)) {
    return sql`(p.gtin = ${q} OR EXISTS (
      SELECT 1 FROM offer_variant v JOIN offer o ON o.id = v.offer_id
       WHERE v.gtin = ${q} AND o.product_id = p.id))`;
  }
  const pattern = containsPattern(q);
  if (!pattern) return null;
  return sql`(p.slug = ${q} OR ${foldedTitleExpr(sql`p.title`)} LIKE ${foldedTitleExpr(sql`${pattern}`)})`;
}

export async function searchProducts(
  db: Database,
  actor: AdminActor,
  filter: ProductSearchFilter = {},
): Promise<{ rows: ProductListRow[]; hasNext: boolean; page: number }> {
  assertCapability(actor, "catalog.read");
  const page = clampPage(filter.page);
  const conditions: SQL[] = [sql`true`];
  const q = queryCondition(filter.query);
  if (q) conditions.push(q);
  if (isProductQualityFilter(filter.quality)) conditions.push(QUALITY_SQL[filter.quality]);
  if (isProductIssueFilter(filter.issue)) conditions.push(ISSUE_SQL[filter.issue]);

  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<ProductRow>(sql`
      SELECT p.id, p.slug, p.title, b.name AS brand_name, c.path AS category_path,
             p.primary_image_url, p.gtin, p.min_price, p.offer_count, p.in_stock_count,
             p.price_updated_at
        FROM product p
        LEFT JOIN brand b ON b.id = p.brand_id
        LEFT JOIN category c ON c.id = p.category_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY p.id DESC
       LIMIT ${CATALOG_PAGE_SIZE + 1} OFFSET ${(page - 1) * CATALOG_PAGE_SIZE}
    `);
    return result.rows;
  });

  return {
    rows: rows.slice(0, CATALOG_PAGE_SIZE).map(toProductRow),
    hasNext: rows.length > CATALOG_PAGE_SIZE,
    page,
  };
}

function toProductRow(row: ProductRow): ProductListRow {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    brandName: row.brand_name,
    categoryPath: row.category_path,
    imageUrl: httpUrl(row.primary_image_url),
    gtin: row.gtin,
    minPrice: row.min_price === null ? null : Number(row.min_price),
    offerCount: row.offer_count,
    inStockCount: row.in_stock_count,
    priceUpdatedAt: row.price_updated_at ? new Date(row.price_updated_at) : null,
  };
}

/** Kalite filtrelerinin toplam sayıları (üst panel). Tek tarama, zaman aşımlı. */
export async function countProductQuality(
  db: Database,
  actor: AdminActor,
): Promise<Record<ProductQualityFilter | "total", number>> {
  assertCapability(actor, "catalog.read");
  return readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<Record<string, string>>(sql`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE ${QUALITY_SQL.no_brand}) AS no_brand,
             count(*) FILTER (WHERE ${QUALITY_SQL.no_category}) AS no_category,
             count(*) FILTER (WHERE ${QUALITY_SQL.no_image}) AS no_image,
             count(*) FILTER (WHERE ${QUALITY_SQL.no_offers}) AS no_offers,
             count(*) FILTER (WHERE ${QUALITY_SQL.no_price}) AS no_price,
             count(*) FILTER (WHERE ${QUALITY_SQL.stale_price}) AS stale_price
        FROM product p
    `);
    const row = result.rows[0] ?? {};
    return {
      total: Number(row.total ?? 0),
      no_brand: Number(row.no_brand ?? 0),
      no_category: Number(row.no_category ?? 0),
      no_image: Number(row.no_image ?? 0),
      no_offers: Number(row.no_offers ?? 0),
      no_price: Number(row.no_price ?? 0),
      stale_price: Number(row.stale_price ?? 0),
    };
  });
}

export interface ProductOfferRow {
  id: number;
  merchantSlug: string;
  merchantName: string;
  merchantActive: boolean;
  externalId: string;
  title: string;
  url: string | null;
  price: number | null;
  listPrice: number | null;
  currency: string;
  inStock: boolean;
  isActive: boolean;
  discoverySource: string;
  lastSeenAt: Date;
  /** Teklif düzeyi barkod (`attributes_raw.gtin`); ürün barkodu bundan eşitlenir. */
  gtin: string | null;
}

export interface ProductVariantRow {
  id: number;
  offerId: number;
  sizeLabel: string | null;
  sku: string | null;
  gtin: string | null;
  gtinSource: string | null;
  inStock: boolean;
  priceOverride: number | null;
}

export interface AdminProductDetail {
  product: ProductListRow & {
    publicId: string;
    mpn: string | null;
    modelKey: string | null;
    color: string | null;
    attributes: Record<string, unknown>;
    maxPrice: number | null;
    createdAt: Date;
    updatedAt: Date;
    categoryDiscoverable: boolean | null;
  };
  offers: ProductOfferRow[];
  offersTruncated: boolean;
  variants: ProductVariantRow[];
  variantsTruncated: boolean;
  candidates: {
    id: number;
    offerId: number;
    score: number;
    method: string;
    status: string;
    reviewReason: string | null;
  }[];
  similarity: Record<string, number>;
  priceStats: {
    min30d: number | null;
    min90d: number | null;
    median90d: number | null;
    currentPercentile: number | null;
    listPriceInflated: boolean;
    computedAt: Date;
  } | null;
  slugHistory: { slug: string; createdAt: Date }[];
}

const DETAIL_OFFER_LIMIT = 100;
const DETAIL_VARIANT_LIMIT = 300;

export async function getProductDetail(
  db: Database,
  actor: AdminActor,
  productId: number,
): Promise<AdminProductDetail | null> {
  assertCapability(actor, "catalog.read");
  if (!isPositiveId(productId)) return null;

  return readOnly(db, 5_000, async (tx) => {
    const productResult = await tx.execute<
      ProductRow & {
        public_id: string;
        mpn: string | null;
        model_key: string | null;
        color: string | null;
        attributes: unknown;
        max_price: string | null;
        created_at: string;
        updated_at: string;
        is_discoverable: boolean | null;
      }
    >(sql`
      SELECT p.id, p.slug, p.title, b.name AS brand_name, c.path AS category_path,
             p.primary_image_url, p.gtin, p.min_price, p.offer_count, p.in_stock_count,
             p.price_updated_at, p.public_id, p.mpn, p.model_key, p.color, p.attributes,
             p.max_price, p.created_at, p.updated_at, c.is_discoverable
        FROM product p
        LEFT JOIN brand b ON b.id = p.brand_id
        LEFT JOIN category c ON c.id = p.category_id
       WHERE p.id = ${productId}
    `);
    const row = productResult.rows[0];
    if (!row) return null;

    const offers = await tx.execute<{
      id: string;
      merchant_slug: string;
      merchant_name: string;
      merchant_active: boolean;
      external_id: string;
      title_raw: string;
      url: string;
      current_price: string | null;
      list_price: string | null;
      currency: string;
      in_stock: boolean;
      is_active: boolean;
      discovery_source: string;
      last_seen_at: string;
      gtin: string | null;
    }>(sql`
      SELECT o.id, m.slug AS merchant_slug, m.name AS merchant_name, m.is_active AS merchant_active,
             o.external_id, o.title_raw, o.url, o.current_price, o.list_price, o.currency,
             o.in_stock, o.is_active, o.discovery_source, o.last_seen_at,
             o.attributes_raw->>'gtin' AS gtin
        FROM offer o JOIN merchant m ON m.id = o.merchant_id
       WHERE o.product_id = ${productId}
       ORDER BY o.is_active DESC, o.current_price ASC NULLS LAST, o.id
       LIMIT ${DETAIL_OFFER_LIMIT + 1}
    `);
    const offerRows = offers.rows.slice(0, DETAIL_OFFER_LIMIT);
    const offerIds = offerRows.map((o) => Number(o.id));

    const variants =
      offerIds.length > 0
        ? await tx.execute<{
            id: string;
            offer_id: string;
            size_label: string | null;
            sku: string | null;
            gtin: string | null;
            gtin_source: string | null;
            in_stock: boolean;
            price_override: string | null;
          }>(sql`
            SELECT id, offer_id, size_label, sku, gtin, gtin_source, in_stock, price_override
              FROM offer_variant
             WHERE offer_id IN (${sql.join(
               offerIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             ORDER BY offer_id, id
             LIMIT ${DETAIL_VARIANT_LIMIT + 1}
          `)
        : { rows: [] };

    const candidates = await tx.execute<{
      id: string;
      offer_id: string;
      score: number;
      method: string;
      status: string;
      review_reason: string | null;
    }>(sql`
      SELECT id, offer_id, score, method, status, review_reason FROM match_candidate
       WHERE product_id = ${productId} ORDER BY id DESC LIMIT 50
    `);

    const similarity = await tx.execute<{ kind: string; n: string }>(sql`
      SELECT kind, count(*) AS n FROM similarity_edge WHERE product_a = ${productId} GROUP BY kind
    `);

    const stats = await tx.execute<{
      min_30d: string | null;
      min_90d: string | null;
      median_90d: string | null;
      current_percentile: number | null;
      list_price_inflated: boolean;
      computed_at: string;
    }>(sql`
      SELECT min_30d, min_90d, median_90d, current_percentile, list_price_inflated, computed_at
        FROM product_price_stats WHERE product_id = ${productId}
    `);

    const slugs = await tx.execute<{ slug: string; created_at: string }>(sql`
      SELECT slug, created_at FROM product_slug_history
       WHERE product_id = ${productId} ORDER BY created_at DESC LIMIT 20
    `);

    const num = (value: string | null) => (value === null ? null : Number(value));
    const s = stats.rows[0];
    return {
      product: {
        ...toProductRow(row),
        publicId: row.public_id,
        mpn: row.mpn,
        modelKey: row.model_key,
        color: row.color,
        attributes:
          row.attributes && typeof row.attributes === "object"
            ? (row.attributes as Record<string, unknown>)
            : {},
        maxPrice: num(row.max_price),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        categoryDiscoverable: row.is_discoverable,
      },
      offers: offerRows.map((o) => ({
        id: Number(o.id),
        merchantSlug: o.merchant_slug,
        merchantName: o.merchant_name,
        merchantActive: o.merchant_active,
        externalId: o.external_id,
        title: o.title_raw,
        url: safeUrl(o.url),
        price: num(o.current_price),
        listPrice: num(o.list_price),
        currency: o.currency,
        inStock: o.in_stock,
        isActive: o.is_active,
        discoverySource: o.discovery_source,
        lastSeenAt: new Date(o.last_seen_at),
        gtin: o.gtin ? o.gtin.slice(0, 64) : null,
      })),
      offersTruncated: offers.rows.length > DETAIL_OFFER_LIMIT,
      variants: variants.rows.slice(0, DETAIL_VARIANT_LIMIT).map((v) => ({
        id: Number(v.id),
        offerId: Number(v.offer_id),
        sizeLabel: v.size_label,
        sku: v.sku,
        gtin: v.gtin,
        gtinSource: v.gtin_source,
        inStock: v.in_stock,
        priceOverride: num(v.price_override),
      })),
      variantsTruncated: variants.rows.length > DETAIL_VARIANT_LIMIT,
      candidates: candidates.rows.map((c) => ({
        id: Number(c.id),
        offerId: Number(c.offer_id),
        score: c.score,
        method: c.method,
        status: c.status,
        reviewReason: c.review_reason,
      })),
      similarity: Object.fromEntries(similarity.rows.map((r) => [r.kind, Number(r.n)])),
      priceStats: s
        ? {
            min30d: num(s.min_30d),
            min90d: num(s.min_90d),
            median90d: num(s.median_90d),
            currentPercentile: s.current_percentile,
            listPriceInflated: s.list_price_inflated,
            computedAt: new Date(s.computed_at),
          }
        : null,
      slugHistory: slugs.rows.map((r) => ({ slug: r.slug, createdAt: new Date(r.created_at) })),
    };
  });
}

export const OFFER_STATES = [
  "unmatched",
  "no_candidate",
  "rejected_only",
  "invalid_gtin",
  "inactive",
  "stale",
  "all",
] as const;
export type OfferState = (typeof OFFER_STATES)[number];

export function isOfferState(value: unknown): value is OfferState {
  return typeof value === "string" && (OFFER_STATES as readonly string[]).includes(value);
}

/** Aktif ama bu kadar gündür feed'de görülmeyen teklif "bayat". */
export const STALE_OFFER_DAYS = 7;

/**
 * GS1 kontrol basamağı (GTIN-8/12/13/14), `services/ingest/collect/
 * identifiers.py` `gtin_valid` ile birebir. `CASE` dalı sıralı değerlendirilir:
 * rakam olmayan değer `::int` dönüşümüne hiç ulaşmaz.
 */
export function validGtinSql(code: SQL): SQL {
  // Ters çevrilmiş kodun 1..14. haneleri, ağırlık 1,3,1,3…; olmayan hane 0.
  // Satır başına alt sorgu (generate_series) yerine düz ifade: 300 bin
  // teklifte ~5 kat hızlı (karar 0053, EXPLAIN kanıtı).
  const terms = Array.from(
    { length: 14 },
    (_, index) =>
      sql`coalesce(nullif(substr(reverse(${code}), ${sql.raw(String(index + 1))}, 1), '')::int, 0) * ${sql.raw(index % 2 === 1 ? "3" : "1")}`,
  );
  return sql`(CASE WHEN ${code} ~ '^([0-9]{8}|[0-9]{12,14})$'
    THEN (${sql.join(terms, sql` + `)}) % 10 = 0
    ELSE false END)`;
}

/** Eşleşmemiş aktif teklifin aday durumu (karar 0053); `match_candidate_uniq (offer_id, …)`. */
const NO_CANDIDATE_SQL = sql`NOT EXISTS (SELECT 1 FROM match_candidate mc WHERE mc.offer_id = o.id)`;
const REJECTED_ONLY_SQL = sql`EXISTS (SELECT 1 FROM match_candidate mc
    WHERE mc.offer_id = o.id AND mc.status = 'rejected')
  AND NOT EXISTS (SELECT 1 FROM match_candidate mc
    WHERE mc.offer_id = o.id AND mc.status <> 'rejected')`;

const OFFER_STATE_SQL: Record<OfferState, SQL> = {
  // `offer_unmatched_idx (merchant_id) WHERE product_id IS NULL`
  unmatched: sql`o.product_id IS NULL AND o.is_active`,
  // Hiç aday kaydı yok: resolver bu teklifi ne kuyruğa aldı ne ürüne bağladı.
  no_candidate: sql`o.product_id IS NULL AND o.is_active AND ${NO_CANDIDATE_SQL}`,
  // Bütün adayları insan tarafından reddedildi, yeni aday yok.
  rejected_only: sql`o.product_id IS NULL AND o.is_active AND ${REJECTED_ONLY_SQL}`,
  invalid_gtin: sql`o.is_active AND o.attributes_raw ? 'gtin'
    AND NOT ${validGtinSql(sql`(o.attributes_raw->>'gtin')`)}`,
  inactive: sql`NOT o.is_active`,
  stale: sql`o.is_active AND o.last_seen_at < now() - (${STALE_OFFER_DAYS} * interval '1 day')`,
  all: sql`true`,
};

export interface OfferListRow {
  id: number;
  merchantSlug: string;
  merchantName: string;
  externalId: string;
  title: string;
  brand: string | null;
  price: number | null;
  inStock: boolean;
  isActive: boolean;
  productId: number | null;
  productSlug: string | null;
  pendingCandidates: number;
  rejectedCandidates: number;
  lastSeenAt: Date;
  /** Bekleme yaşı için: teklifin ilk görüldüğü an. */
  firstSeenAt: Date;
  /** Teklif düzeyi barkod (`attributes_raw.gtin`), olduğu gibi. */
  gtin: string | null;
  /** Kesin kimlik kanalı girdisi: teklif barkodu/MPN'si ya da varyant barkodu var. */
  hasIdentifier: boolean;
  /** Görsel kanal girdisi: teklifin görsel vektörü var. */
  hasImageVector: boolean;
}

export async function listOffers(
  db: Database,
  actor: AdminActor,
  filter: {
    state?: OfferState;
    merchantId?: number;
    query?: string;
    beforeId?: number;
    pageSize?: number;
  } = {},
): Promise<{ rows: OfferListRow[]; nextBeforeId: number | null }> {
  assertCapability(actor, "catalog.read");
  const pageSize = clampPageSize(filter.pageSize);
  const state: OfferState = isOfferState(filter.state) ? filter.state : "unmatched";
  const conditions: SQL[] = [OFFER_STATE_SQL[state]];
  if (isPositiveId(filter.merchantId)) conditions.push(sql`o.merchant_id = ${filter.merchantId}`);
  const q = filter.query?.trim() ?? "";
  const idMatch = /^#(\d{1,15})$/.exec(q);
  if (idMatch && isPositiveId(Number(idMatch[1]))) {
    // `#123`: teklif kimliği (kalite sayfasının örnek bağlantıları).
    conditions.push(sql`o.id = ${Number(idMatch[1])}`);
  } else if (q) {
    const pattern = containsPattern(q);
    // Teklif başlığında trigram indeksi yok: arama zaman aşımıyla sınırlı.
    if (pattern) conditions.push(sql`(o.external_id = ${q} OR o.title_raw ILIKE ${pattern})`);
  }
  if (isPositiveId(filter.beforeId)) conditions.push(sql`o.id < ${filter.beforeId}`);

  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<{
      id: string;
      merchant_slug: string;
      merchant_name: string;
      external_id: string;
      title_raw: string;
      brand_raw: string | null;
      current_price: string | null;
      in_stock: boolean;
      is_active: boolean;
      product_id: string | null;
      product_slug: string | null;
      pending: string;
      rejected: string;
      last_seen_at: string;
      first_seen_at: string;
      gtin: string | null;
      has_identifier: boolean;
      has_image_vector: boolean;
    }>(sql`
      SELECT o.id, m.slug AS merchant_slug, m.name AS merchant_name, o.external_id, o.title_raw,
             o.brand_raw, o.current_price, o.in_stock, o.is_active, o.product_id,
             p.slug AS product_slug,
             (SELECT count(*) FROM match_candidate mc
               WHERE mc.offer_id = o.id AND mc.status = 'pending') AS pending,
             (SELECT count(*) FROM match_candidate mc
               WHERE mc.offer_id = o.id AND mc.status = 'rejected') AS rejected,
             o.last_seen_at, o.first_seen_at, o.attributes_raw->>'gtin' AS gtin,
             (o.attributes_raw ? 'gtin' OR o.attributes_raw ? 'mpn' OR EXISTS (
               SELECT 1 FROM offer_variant v WHERE v.offer_id = o.id AND v.gtin IS NOT NULL
             )) AS has_identifier,
             EXISTS (SELECT 1 FROM embedding e
                      WHERE e.target_type = 'offer' AND e.target_id = o.id AND e.kind = 'image'
             ) AS has_image_vector
        FROM offer o
        JOIN merchant m ON m.id = o.merchant_id
        LEFT JOIN product p ON p.id = o.product_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY o.id DESC
       LIMIT ${pageSize + 1}
    `);
    return result.rows;
  });

  const page = rows.slice(0, pageSize).map(
    (o): OfferListRow => ({
      id: Number(o.id),
      merchantSlug: o.merchant_slug,
      merchantName: o.merchant_name,
      externalId: o.external_id,
      title: o.title_raw,
      brand: o.brand_raw,
      price: o.current_price === null ? null : Number(o.current_price),
      inStock: o.in_stock,
      isActive: o.is_active,
      productId: o.product_id === null ? null : Number(o.product_id),
      productSlug: o.product_slug,
      pendingCandidates: Number(o.pending),
      rejectedCandidates: Number(o.rejected),
      lastSeenAt: new Date(o.last_seen_at),
      firstSeenAt: new Date(o.first_seen_at),
      gtin: o.gtin ? o.gtin.slice(0, 64) : null,
      hasIdentifier: o.has_identifier,
      hasImageVector: o.has_image_vector,
    }),
  );
  const last = page[page.length - 1];
  return { rows: page, nextBeforeId: rows.length > pageSize && last ? last.id : null };
}
