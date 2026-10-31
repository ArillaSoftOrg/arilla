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
import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MEDIUM_MIN,
  FRESHNESS_DAYS,
  type ProductBrandFilter,
  type ProductClassificationFilter,
  type ProductConfidenceFilter,
  type ProductFreshnessFilter,
  type ProductImageFilter,
  type ProductPriceFilter,
  UNASSIGNED,
} from "./catalog-filters.ts";
import { OFFER_SEEN_AT, offerNotSeenSince } from "./offer-seen.ts";
import { httpUrl, safeUrl } from "./redact.ts";

export const PRODUCT_QUALITY_FILTERS = [
  "no_brand",
  "no_category",
  "no_image",
  "no_offers",
  "no_price",
  "stale_price",
  "foreign_only",
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

/**
 * Fiyat özeti TRY-only'dir (`min_price`, `offer_count`; karar 0121): yalnızca yurt
 * dışı (ör. AliExpress USD) teklifi olan ürün orada "mağazasız, fiyatsız" görünür.
 * `foreign_offer_count` (0076, karar 0127) aktif mağazanın fiyatlı aktif TRY dışı
 * teklifini sayar; "mağazası yok" ve "fiyatsız" ikisine birden bakar.
 */
const QUALITY_SQL: Record<ProductQualityFilter, SQL> = {
  no_brand: sql`p.brand_id IS NULL`,
  no_category: sql`p.category_id IS NULL`,
  no_image: sql`p.primary_image_url IS NULL`,
  no_offers: sql`(p.offer_count = 0 AND p.foreign_offer_count = 0)`,
  no_price: sql`(p.min_price IS NULL AND p.foreign_offer_count = 0)`,
  stale_price: sql`(p.price_updated_at IS NULL OR p.price_updated_at < now() - (${STALE_PRICE_DAYS} * interval '1 day'))`,
  // Kusur değil, durum: fiyatı yalnızca yurt dışı para biriminde (TL karşılaştırmasına girmez).
  foreign_only: sql`(p.offer_count = 0 AND p.foreign_offer_count > 0)`,
};

export interface ProductListRow {
  id: number;
  slug: string;
  title: string;
  brandName: string | null;
  categoryPath: string | null;
  imageUrl: string | null;
  gtin: string | null;
  /** TRY en düşük fiyat, kuruş. TRY dışı tutar buraya girmez. */
  minPrice: number | null;
  offerCount: number;
  inStockCount: number;
  /** TRY dışı fiyatlı aktif teklifi olan aktif mağaza sayısı (karar 0127). */
  foreignOfferCount: number;
  /** Para birimi başına en düşük TRY dışı fiyat (kendi küçük biriminde); TL'ye çevrilmez. */
  foreignPrices: CatalogForeignPrice[];
  priceUpdatedAt: Date | null;
  publicationState: ProductPublicationState;
  holdReason: string | null;
  /** Kaynak ilanın mağazası (karar 0121); eşleştirmeyle oluşan üründe yok. */
  sourceMerchant: { slug: string; name: string } | null;
  /** Sınıflandırma kanıtı (karar 0133); iş bu ürüne gelmediyse `null`. */
  classification: ProductClassificationSummary | null;
}

export type ProductPublicationState = "draft" | "ready" | "held" | "published";

export interface ProductClassificationSummary {
  state: "applied" | "review" | "error";
  /** Kategori kararının güveni (0–100); ≥ 80 ürüne yazılır. */
  confidence: number;
  brandBasis: string;
  categoryBasis: string;
  wroteBrand: boolean;
  wroteCategory: boolean;
  ruleVersion: number;
}

/** Liste satırının teklif mağazaları (aktif teklif; sayfa satırları için tek ek sorgu). */
export interface ProductListMerchant {
  slug: string;
  name: string;
}

export interface CatalogForeignPrice {
  currency: string;
  /** Para biriminin küçük birimi (USD için cent). */
  minPrice: number;
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

/**
 * Yayın durumu süzgeci (karar 0121). Varsayılan `published`: milyonlarca taslak
 * (kaynak ilanı) liste ve sayaçlara girmez. Taslaklar kimlik, slug ya da kaynak
 * kimliğiyle bulunur (başlık indeksi yalnızca yayınlanmışları kapsar).
 */
export const PRODUCT_STATE_FILTERS = ["published", "draft", "ready", "held", "all"] as const;
export type ProductStateFilter = (typeof PRODUCT_STATE_FILTERS)[number];

export function isProductStateFilter(value: unknown): value is ProductStateFilter {
  return typeof value === "string" && (PRODUCT_STATE_FILTERS as readonly string[]).includes(value);
}

export interface ProductSearchFilter {
  /** Yayın durumu; verilmezse `published`. */
  state?: ProductStateFilter;
  /** Sayı → id; 8–14 hane → GTIN (ürün ya da varyant); diğer → başlık. */
  query?: string;
  quality?: ProductQualityFilter;
  issue?: ProductIssueFilter;
  /** Aktif teklifi olan mağaza (slug; `offer_merchant_state_idx`). */
  merchant?: string;
  brand?: ProductBrandFilter;
  /** Kategori yolu (alt dallar dahil) ya da `none`. */
  category?: string;
  classification?: ProductClassificationFilter;
  confidence?: ProductConfidenceFilter;
  price?: ProductPriceFilter;
  image?: ProductImageFilter;
  freshness?: ProductFreshnessFilter;
  /** Anahtar kümeli imleç: `p.id < before` (sonraki sayfa). */
  before?: number;
  /** Anahtar kümeli imleç: `p.id > after` (önceki sayfa). */
  after?: number;
  /** Eski ofset sayfalaması (imleç yoksa). */
  page?: number;
}

export interface ProductSearchResult {
  rows: ProductListRow[];
  /** Sayfa satırlarının aktif teklif mağazaları (ürün başına en çok 3, ada göre). */
  merchants: Map<number, ProductListMerchant[]>;
  hasNext: boolean;
  /** Bu sayfadan önce satır olabilir mi (imleçle gelindiyse ya da ofset > 0). */
  hasPrev: boolean;
  /** Sonraki sayfa imleci (`before`); yoksa `null`. */
  nextBefore: number | null;
  /** Önceki sayfa imleci (`after`); yoksa `null`. */
  prevAfter: number | null;
  page: number;
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
  foreign_offer_count: number;
  price_updated_at: string | null;
  publication_state: ProductPublicationState;
  hold_reason: string | null;
  source_merchant_slug: string | null;
  source_merchant_name: string | null;
  pc_state: "applied" | "review" | "error" | null;
  pc_confidence: number | null;
  pc_brand_basis: string | null;
  pc_category_basis: string | null;
  pc_wrote_brand: boolean | null;
  pc_wrote_category: boolean | null;
  pc_rule_version: number | null;
};

/** Liste ve ayrıntı satırının ortak kolonları (`p`, `b`, `c`, `sm`, `pc` takma adlarıyla). */
const PRODUCT_ROW_COLUMNS = sql`
  p.id, p.slug, p.title, b.name AS brand_name, c.path AS category_path,
  p.primary_image_url, p.gtin, p.min_price, p.offer_count, p.in_stock_count,
  p.foreign_offer_count, p.price_updated_at, p.publication_state, p.hold_reason,
  sm.slug AS source_merchant_slug, sm.name AS source_merchant_name,
  pc.state AS pc_state, pc.confidence AS pc_confidence, pc.brand_basis AS pc_brand_basis,
  pc.category_basis AS pc_category_basis, pc.wrote_brand AS pc_wrote_brand,
  pc.wrote_category AS pc_wrote_category, pc.rule_version AS pc_rule_version`;

/** Birincil anahtar birleştirmeleri: sayfa başına en çok 51 satır için ucuz. */
const PRODUCT_ROW_JOINS = sql`
  LEFT JOIN brand b ON b.id = p.brand_id
  LEFT JOIN category c ON c.id = p.category_id
  LEFT JOIN merchant sm ON sm.id = p.source_merchant_id
  LEFT JOIN product_classification pc ON pc.product_id = p.id`;

/**
 * Verilen ürünlerin para birimi başına en düşük TRY dışı fiyatı. Özetle aynı kural
 * (aktif mağazanın fiyatlı aktif teklifi). Yalnızca `foreign_offer_count > 0` olan
 * sayfa satırları için çağrılır: TRY kataloğu için ek sorgu yok.
 */
async function foreignPriceSummaries(
  tx: Pick<Database, "execute">,
  productIds: number[],
): Promise<Map<number, CatalogForeignPrice[]>> {
  const byProduct = new Map<number, CatalogForeignPrice[]>();
  if (productIds.length === 0) return byProduct;
  const result = await tx.execute<{ product_id: string; currency: string; min_price: string }>(sql`
    SELECT o.product_id, o.currency, min(o.current_price) AS min_price
      FROM offer o JOIN merchant m ON m.id = o.merchant_id AND m.is_active
     WHERE o.product_id = ANY(${sql.param(productIds)}::bigint[])
       AND o.is_active AND o.current_price IS NOT NULL AND o.currency <> 'TRY'
     GROUP BY o.product_id, o.currency
     ORDER BY o.product_id, o.currency
  `);
  for (const row of result.rows) {
    const id = Number(row.product_id);
    const list = byProduct.get(id) ?? [];
    list.push({ currency: row.currency, minPrice: Number(row.min_price) });
    byProduct.set(id, list);
  }
  return byProduct;
}

function foreignIds(rows: readonly ProductRow[]): number[] {
  return rows.filter((row) => row.foreign_offer_count > 0).map((row) => Number(row.id));
}

function queryCondition(query: string | undefined): SQL | null {
  const q = query?.trim() ?? "";
  if (!q) return null;
  if (/^#?\d{1,7}$/.test(q)) return sql`p.id = ${Number(q.replace("#", ""))}`;
  // Kaynak ilan kimliği (ör. 16 haneli AliExpress ürün kimliği): benzersiz indeksle.
  if (/^\d{15,20}$/.test(q)) return sql`p.source_external_id = ${q}`;
  if (/^\d{8,14}$/.test(q)) {
    return sql`(p.gtin = ${q} OR EXISTS (
      SELECT 1 FROM offer_variant v JOIN offer o ON o.id = v.offer_id
       WHERE v.gtin = ${q} AND o.product_id = p.id))`;
  }
  const pattern = containsPattern(q);
  if (!pattern) return null;
  return sql`(p.slug = ${q} OR ${foldedTitleExpr(sql`p.title`)} LIKE ${foldedTitleExpr(sql`${pattern}`)})`;
}

/**
 * Marka adı ve kategori yolu önce KİMLİĞE çözülür, sonra `= ANY(dizi)` ile süzülür.
 * Alt sorgu (`IN (SELECT …)`) seçiciliğini planlayıcı kestiremez ve nadir/boş bir
 * kategoride bile tüm tabloyu `p.id` sırasıyla geriye tarar (2 M satırda 2,6 sn);
 * değer dizisiyle istatistik kullanılır, nadir değerde `product_brand_idx` /
 * `product_category_idx` seçilir (0,1 ms), boş dizi hiç satır okumaz.
 */
interface ResolvedIds {
  brandIds?: number[];
  categoryIds?: number[];
}

async function resolveFilterIds(
  tx: Pick<Database, "execute">,
  filter: ProductSearchFilter,
): Promise<ResolvedIds> {
  const resolved: ResolvedIds = {};
  const brand = filter.brand;
  if (brand !== undefined && brand !== UNASSIGNED && typeof brand !== "number") {
    // Ad ya da slug, birebir (büyük/küçük harf duyarsız). Marka tablosu küçük.
    const name = brand.name.trim().slice(0, 80);
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id FROM brand WHERE slug = ${name} OR lower(name) = lower(${name}) LIMIT 50
    `);
    resolved.brandIds = result.rows.map((r) => Number(r.id));
  }
  if (filter.category && filter.category !== UNASSIGNED) {
    // Yol `[a-z0-9-/]` ile doğrulandı (LIKE jokeri içermez); `category_path_idx` önek araması.
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id FROM category WHERE path = ${filter.category} OR path LIKE ${`${filter.category}/%`}
    `);
    resolved.categoryIds = result.rows.map((r) => Number(r.id));
  }
  return resolved;
}

function brandCondition(brand: ProductBrandFilter, ids: number[] | undefined): SQL {
  if (brand === UNASSIGNED) return sql`p.brand_id IS NULL`;
  if (typeof brand === "number") return sql`p.brand_id = ${brand}`;
  return sql`p.brand_id = ANY(${sql.param(ids ?? [])}::bigint[])`;
}

function categoryCondition(category: string, ids: number[] | undefined): SQL {
  if (category === UNASSIGNED) return sql`p.category_id IS NULL`;
  return sql`p.category_id = ANY(${sql.param(ids ?? [])}::bigint[])`;
}

const CLASSIFICATION_SQL: Record<ProductClassificationFilter, SQL> = {
  applied: sql`pc.state = 'applied'`,
  auto_written: sql`(pc.wrote_brand OR pc.wrote_category)`,
  // `product_classification_open_idx` (state, product_id) WHERE state <> 'applied'.
  review: sql`pc.state = 'review'`,
  error: sql`pc.state = 'error'`,
  // Kontrol noktasından SONRAKİ kanıtsız ürünler (`countProductClassification`
  // "bekleyen" ile aynı sınır). İş ürünleri kimlik sırasıyla tarar; noktanın
  // gerisindeki her ürünün kanıt satırı vardır. Sınır olmadan, sınıflandırma
  // bitince bu süzgeç 2,7 M ürünün her biri için kanıt arardı (2 M satırda 14 sn).
  unscanned: sql`(pc.product_id IS NULL AND p.id > (
    SELECT coalesce(max(cs.last_product_id), 0) FROM product_classification_state cs
     WHERE cs.scope = 'all'))`,
};

function confidenceCondition(confidence: ProductConfidenceFilter): SQL {
  if (confidence === "high") return sql`pc.confidence >= ${CONFIDENCE_HIGH_MIN}`;
  if (confidence === "medium") {
    return sql`(pc.confidence >= ${CONFIDENCE_MEDIUM_MIN} AND pc.confidence < ${CONFIDENCE_HIGH_MIN})`;
  }
  return sql`pc.confidence < ${CONFIDENCE_MEDIUM_MIN}`;
}

function priceCondition(price: ProductPriceFilter): SQL {
  if (price === "try") return sql`p.min_price IS NOT NULL`;
  return price === "foreign_only" ? QUALITY_SQL.foreign_only : QUALITY_SQL.no_price;
}

function imageCondition(image: ProductImageFilter): SQL {
  return image === "with" ? sql`p.primary_image_url IS NOT NULL` : QUALITY_SQL.no_image;
}

function freshnessCondition(freshness: ProductFreshnessFilter): SQL {
  if (freshness === "stale") return QUALITY_SQL.stale_price;
  return sql`p.price_updated_at >= now() - (${FRESHNESS_DAYS[freshness]} * interval '1 day')`;
}

/** Süzgeç → WHERE koşulları (hepsi AND ile birleşir). */
function productConditions(filter: ProductSearchFilter, ids: ResolvedIds = {}): SQL[] {
  const conditions: SQL[] = [sql`true`];
  const state = isProductStateFilter(filter.state) ? filter.state : "published";
  if (state !== "all") conditions.push(sql`p.publication_state = ${state}`);
  const q = queryCondition(filter.query);
  if (q) conditions.push(q);
  if (isProductQualityFilter(filter.quality)) conditions.push(QUALITY_SQL[filter.quality]);
  if (isProductIssueFilter(filter.issue)) conditions.push(ISSUE_SQL[filter.issue]);
  if (filter.merchant) {
    // `offer_merchant_state_idx` (merchant_id, is_active, product_id): yalnız indeks taraması.
    conditions.push(sql`p.id IN (SELECT mo.product_id FROM offer mo
                                  WHERE mo.merchant_id = (SELECT mf.id FROM merchant mf
                                                           WHERE mf.slug = ${filter.merchant})
                                    AND mo.is_active AND mo.product_id IS NOT NULL)`);
  }
  if (filter.brand !== undefined) conditions.push(brandCondition(filter.brand, ids.brandIds));
  if (filter.category) conditions.push(categoryCondition(filter.category, ids.categoryIds));
  if (filter.classification) conditions.push(CLASSIFICATION_SQL[filter.classification]);
  if (filter.confidence) conditions.push(confidenceCondition(filter.confidence));
  if (filter.price) conditions.push(priceCondition(filter.price));
  if (filter.image) conditions.push(imageCondition(filter.image));
  if (filter.freshness) conditions.push(freshnessCondition(filter.freshness));
  return conditions;
}

/** Sayfa satırlarının aktif teklif mağazaları (ürün başına en çok 3). */
async function pageMerchants(
  tx: Pick<Database, "execute">,
  productIds: number[],
): Promise<Map<number, ProductListMerchant[]>> {
  const byProduct = new Map<number, ProductListMerchant[]>();
  if (productIds.length === 0) return byProduct;
  const result = await tx.execute<{ product_id: string; slug: string; name: string }>(sql`
    SELECT DISTINCT o.product_id, m.slug, m.name
      FROM offer o JOIN merchant m ON m.id = o.merchant_id
     WHERE o.product_id = ANY(${sql.param(productIds)}::bigint[]) AND o.is_active
     ORDER BY o.product_id, m.name
  `);
  for (const row of result.rows) {
    const id = Number(row.product_id);
    const list = byProduct.get(id) ?? [];
    if (list.length < 3) list.push({ slug: row.slug, name: row.name });
    byProduct.set(id, list);
  }
  return byProduct;
}

/**
 * Ürün listesi: en yeni önce (`p.id DESC`), sunucu tarafı süzgeç ve sayfalama.
 * Toplam sayım ÇALIŞTIRILMAZ (2,7 M satırda her sayfada COUNT pahalıdır);
 * `LIMIT n+1` ile yalnızca sonraki sayfanın varlığı bilinir. Sayfalama anahtar
 * kümelidir (`before`/`after`): derin sayfada ofset taraması yok.
 */
export async function searchProducts(
  db: Database,
  actor: AdminActor,
  filter: ProductSearchFilter = {},
): Promise<ProductSearchResult> {
  assertCapability(actor, "catalog.read");
  const before = isPositiveId(filter.before) ? filter.before : undefined;
  const after = before === undefined && isPositiveId(filter.after) ? filter.after : undefined;
  const page = before === undefined && after === undefined ? clampPage(filter.page) : 1;
  const cursor: SQL[] = [];
  if (before !== undefined) cursor.push(sql`p.id < ${before}`);
  if (after !== undefined) cursor.push(sql`p.id > ${after}`);
  // Önceki sayfa: artan sırayla okunur, sonra ters çevrilir (yine indeks sırası).
  const order = after !== undefined ? sql`p.id ASC` : sql`p.id DESC`;
  const offset = (page - 1) * CATALOG_PAGE_SIZE;

  // Sınıflandırma tablosu süzgeçte yalnızca o filtre seçiliyse birleşir.
  const classificationJoin =
    filter.classification || filter.confidence
      ? sql`LEFT JOIN product_classification pc ON pc.product_id = p.id`
      : sql``;

  const rows = await readOnly(db, 5_000, async (tx) => {
    const conditions = [
      ...productConditions(filter, await resolveFilterIds(tx, filter)),
      ...cursor,
    ];
    // İki aşama: önce yalnızca `product` üzerinde süz ve sayfanın kimliklerini al;
    // görüntü birleştirmeleri yalnızca bu en çok 51 satıra uygulanır (geniş bir
    // başlık eşleşmesinde 200 bin satırın her birine değil).
    const result = await tx.execute<ProductRow>(sql`
      WITH page AS (
        SELECT p.id
          FROM product p
          ${classificationJoin}
         WHERE ${sql.join(conditions, sql` AND `)}
         ORDER BY ${order}
         LIMIT ${CATALOG_PAGE_SIZE + 1} OFFSET ${offset}
      )
      SELECT ${PRODUCT_ROW_COLUMNS}
        FROM page JOIN product p ON p.id = page.id
        ${PRODUCT_ROW_JOINS}
       ORDER BY ${order}
    `);
    const more = result.rows.length > CATALOG_PAGE_SIZE;
    const sliced = result.rows.slice(0, CATALOG_PAGE_SIZE);
    const pageRows = after !== undefined ? sliced.reverse() : sliced;
    const foreign = await foreignPriceSummaries(tx, foreignIds(pageRows));
    const merchants = await pageMerchants(
      tx,
      pageRows.map((row) => Number(row.id)),
    );
    return { more, pageRows, foreign, merchants };
  });

  const list = rows.pageRows.map((row) =>
    toProductRow(row, rows.foreign.get(Number(row.id)) ?? []),
  );
  const first = list[0]?.id ?? null;
  const last = list.at(-1)?.id ?? null;
  // `after` ile gelindiyse sonrası vardır (oradan gelindi); fazlalık satır öncesini gösterir.
  const hasNext = after !== undefined ? last !== null : rows.more;
  const hasPrev = after !== undefined ? rows.more : before !== undefined || page > 1;
  return {
    rows: list,
    merchants: rows.merchants,
    hasNext,
    hasPrev,
    nextBefore: hasNext ? last : null,
    prevAfter: hasPrev ? first : null,
    page,
  };
}

function toProductRow(row: ProductRow, foreignPrices: CatalogForeignPrice[]): ProductListRow {
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
    foreignOfferCount: row.foreign_offer_count,
    foreignPrices,
    priceUpdatedAt: row.price_updated_at ? new Date(row.price_updated_at) : null,
    publicationState: row.publication_state,
    holdReason: row.hold_reason,
    sourceMerchant:
      row.source_merchant_slug && row.source_merchant_name
        ? { slug: row.source_merchant_slug, name: row.source_merchant_name }
        : null,
    classification: row.pc_state
      ? {
          state: row.pc_state,
          confidence: Number(row.pc_confidence ?? 0),
          brandBasis: row.pc_brand_basis ?? "none",
          categoryBasis: row.pc_category_basis ?? "none",
          wroteBrand: Boolean(row.pc_wrote_brand),
          wroteCategory: Boolean(row.pc_wrote_category),
          ruleVersion: Number(row.pc_rule_version ?? 0),
        }
      : null,
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
             count(*) FILTER (WHERE ${QUALITY_SQL.stale_price}) AS stale_price,
             count(*) FILTER (WHERE ${QUALITY_SQL.foreign_only}) AS foreign_only
        FROM product p
       WHERE p.publication_state = 'published'
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
      foreign_only: Number(row.foreign_only ?? 0),
    };
  });
}

/**
 * Yayındaki ürünlerin marka/kategori sınıflandırma durumu (karar 0133).
 *
 * - `pending`: sınıflandırma işinin (`classify products`, kapsam `all`) henüz taramadığı
 *   ve markası ya da kategorisi eksik yayındaki ürünler + incelemede bekleyenler.
 * - `review`: kanıt yetersiz/çelişkili olduğu için kategorisi yazılmamış, bekleyen ürünler.
 * - `errors`: işlenemeyen (ör. eşzamanlı değişiklik) ürünler; sonraki tarama yeniden dener.
 * Kontrol noktası en yeni kural sürümünündür; iş hiç çalışmadıysa tüm eksikler bekler.
 */
export interface ProductClassificationCounts {
  pending: number;
  review: number;
  errors: number;
  ruleVersion: number | null;
  lastRunAt: Date | null;
  completedAt: Date | null;
}

export async function countProductClassification(
  db: Database,
  actor: AdminActor,
): Promise<ProductClassificationCounts> {
  assertCapability(actor, "catalog.read");
  return readOnly(db, 5_000, async (tx) => {
    const state = await tx.execute<{
      rule_version: number;
      last_product_id: string;
      updated_at: string;
      completed_at: string | null;
    }>(sql`
      SELECT rule_version, last_product_id, updated_at, completed_at
        FROM product_classification_state
       WHERE scope = 'all'
       ORDER BY rule_version DESC
       LIMIT 1
    `);
    const checkpoint = state.rows[0];
    const after = checkpoint ? Number(checkpoint.last_product_id) : 0;
    const result = await tx.execute<{ unscanned: string; review: string; errors: string }>(sql`
      SELECT
        (SELECT count(*) FROM product p
          WHERE p.publication_state = 'published' AND p.id > ${after}
            AND (p.brand_id IS NULL OR p.category_id IS NULL)) AS unscanned,
        (SELECT count(*) FROM product_classification pc
           JOIN product p ON p.id = pc.product_id AND p.publication_state = 'published'
          WHERE pc.state = 'review' AND pc.product_id <= ${after}) AS review,
        (SELECT count(*) FROM product_classification pc
           JOIN product p ON p.id = pc.product_id AND p.publication_state = 'published'
          WHERE pc.state = 'error') AS errors
    `);
    const row = result.rows[0];
    const review = Number(row?.review ?? 0);
    return {
      pending: Number(row?.unscanned ?? 0) + review,
      review,
      errors: Number(row?.errors ?? 0),
      ruleVersion: checkpoint ? Number(checkpoint.rule_version) : null,
      lastRunAt: checkpoint ? new Date(checkpoint.updated_at) : null,
      completedAt: checkpoint?.completed_at ? new Date(checkpoint.completed_at) : null,
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
      SELECT ${PRODUCT_ROW_COLUMNS}, p.public_id, p.mpn, p.model_key, p.color, p.attributes,
             p.max_price, p.created_at, p.updated_at, c.is_discoverable
        FROM product p
        ${PRODUCT_ROW_JOINS}
       WHERE p.id = ${productId}
    `);
    const row = productResult.rows[0];
    if (!row) return null;
    const foreign = await foreignPriceSummaries(tx, foreignIds([row]));

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
             o.in_stock, o.is_active, o.discovery_source, ${OFFER_SEEN_AT} AS last_seen_at,
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
        ...toProductRow(row, foreign.get(Number(row.id)) ?? []),
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

/**
 * Aktif ama bu kadar gündür feed'de görülmeyen teklif "bayat". Yönetim GÖSTERGESİDİR;
 * yeni yayın eşiği değildir: `catalog_build` kapısı/yayını `PUBLISH_STALE_DAYS` (2) kullanır
 * (karar 0160). İki değer bilerek ayrıdır.
 */
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
  stale: sql`o.is_active AND ${offerNotSeenSince(sql`now() - (${STALE_OFFER_DAYS} * interval '1 day')`)}`,
  all: sql`true`,
};

export interface OfferListRow {
  id: number;
  merchantSlug: string;
  merchantName: string;
  externalId: string;
  title: string;
  brand: string | null;
  /** Teklifin kendi para biriminde, küçük birim (TRY için kuruş). */
  price: number | null;
  currency: string;
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
      currency: string;
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
             o.brand_raw, o.current_price, o.currency, o.in_stock, o.is_active, o.product_id,
             p.slug AS product_slug,
             (SELECT count(*) FROM match_candidate mc
               WHERE mc.offer_id = o.id AND mc.status = 'pending') AS pending,
             (SELECT count(*) FROM match_candidate mc
               WHERE mc.offer_id = o.id AND mc.status = 'rejected') AS rejected,
             ${OFFER_SEEN_AT} AS last_seen_at, o.first_seen_at, o.attributes_raw->>'gtin' AS gtin,
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
      currency: o.currency,
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
