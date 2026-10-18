/**
 * `/yonetim/katalog/urunler` sağ panel ve `/yonetim/katalog/siniflandirma`
 * izleme ekranı. SALT OKUNUR (karar 0039): marka/kategori elle düzeltme için
 * denetimli bir yazma yolu henüz yok; panel kararın dayanağını gösterir.
 *
 * Sınıflandırma verisi Python toplu işinin (`classify products`, karar 0133)
 * yazdığı tablolardan okunur; bu modül işi başlatmaz, durdurmaz, değiştirmez.
 */

import type { Database, JobRunStatus } from "@arilla/db";
import { sql } from "drizzle-orm";
import { isPositiveId, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { STUCK_JOB_AFTER_MS } from "./job-runs.ts";
import { httpUrl, safeUrl } from "./redact.ts";

export interface ProductPanelOffer {
  id: number;
  merchantSlug: string;
  merchantName: string;
  merchantActive: boolean;
  externalId: string;
  url: string | null;
  /** Kendi para biriminin küçük birimi (TRY kuruş, USD cent); TL'ye çevrilmez. */
  price: number | null;
  currency: string;
  inStock: boolean;
  isActive: boolean;
  isSource: boolean;
  lastSeenAt: Date;
}

export interface ProductPanelClassification {
  ruleVersion: number;
  state: "applied" | "review" | "error";
  confidence: number;
  brandBasis: string;
  categoryBasis: string;
  /** Kuralın önerdiği/yazdığı marka (ürünün mevcut markasından farklı olabilir). */
  brandName: string | null;
  categoryPath: string | null;
  compatibleBrands: string[];
  wroteBrand: boolean;
  wroteCategory: boolean;
  detail: string | null;
  classifiedAt: Date;
}

export interface ProductPanel {
  id: number;
  publicId: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  gtin: string | null;
  brand: { id: number; name: string } | null;
  category: { id: number; path: string; name: string } | null;
  publicationState: string;
  holdReason: string | null;
  publishedAt: Date | null;
  sourceMerchant: { slug: string; name: string } | null;
  sourceExternalId: string | null;
  /** Kaynak teklif (karar 0121); yoksa `null`. */
  sourceOffer: ProductPanelOffer | null;
  /** Aktif teklifler önce, fiyata göre; en çok `PANEL_OFFER_LIMIT`. */
  offers: ProductPanelOffer[];
  offersTruncated: boolean;
  minPrice: number | null;
  offerCount: number;
  inStockCount: number;
  foreignOfferCount: number;
  priceUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  classification: ProductPanelClassification | null;
}

export const PANEL_OFFER_LIMIT = 5;

type OfferSqlRow = {
  id: string;
  merchant_slug: string;
  merchant_name: string;
  merchant_active: boolean;
  external_id: string;
  url: string;
  current_price: string | null;
  currency: string;
  in_stock: boolean;
  is_active: boolean;
  last_seen_at: string;
};

function toOffer(row: OfferSqlRow, sourceOfferId: number | null): ProductPanelOffer {
  const id = Number(row.id);
  return {
    id,
    merchantSlug: row.merchant_slug,
    merchantName: row.merchant_name,
    merchantActive: row.merchant_active,
    externalId: row.external_id,
    url: safeUrl(row.url),
    price: row.current_price === null ? null : Number(row.current_price),
    currency: row.currency.trim(),
    inStock: row.in_stock,
    isActive: row.is_active,
    isSource: sourceOfferId === id,
    lastSeenAt: new Date(row.last_seen_at),
  };
}

const OFFER_COLUMNS = sql`
  o.id, m.slug AS merchant_slug, m.name AS merchant_name, m.is_active AS merchant_active,
  o.external_id, o.url, o.current_price, o.currency, o.in_stock, o.is_active, o.last_seen_at`;

/** Sağ panel: tek ürün, birincil anahtarla; teklifler `offer_product_idx` ile sınırlı. */
export async function getProductPanel(
  db: Database,
  actor: AdminActor,
  productId: number,
): Promise<ProductPanel | null> {
  assertCapability(actor, "catalog.read");
  if (!isPositiveId(productId)) return null;

  return readOnly(db, 3_000, async (tx) => {
    const result = await tx.execute<{
      id: string;
      public_id: string;
      slug: string;
      title: string;
      primary_image_url: string | null;
      gtin: string | null;
      brand_id: string | null;
      brand_name: string | null;
      category_id: string | null;
      category_path: string | null;
      category_name: string | null;
      publication_state: string;
      hold_reason: string | null;
      published_at: string | null;
      source_merchant_slug: string | null;
      source_merchant_name: string | null;
      source_external_id: string | null;
      source_offer_id: string | null;
      min_price: string | null;
      offer_count: number;
      in_stock_count: number;
      foreign_offer_count: number;
      price_updated_at: string | null;
      created_at: string;
      updated_at: string;
      pc_rule_version: number | null;
      pc_state: "applied" | "review" | "error" | null;
      pc_confidence: number | null;
      pc_brand_basis: string | null;
      pc_category_basis: string | null;
      pc_brand_name: string | null;
      pc_category_path: string | null;
      pc_compatible: string[] | null;
      pc_wrote_brand: boolean | null;
      pc_wrote_category: boolean | null;
      pc_detail: string | null;
      pc_classified_at: string | null;
    }>(sql`
      SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url, p.gtin,
             p.brand_id, b.name AS brand_name, p.category_id, c.path AS category_path,
             c.name AS category_name, p.publication_state, p.hold_reason, p.published_at,
             sm.slug AS source_merchant_slug, sm.name AS source_merchant_name,
             p.source_external_id, p.source_offer_id, p.min_price, p.offer_count,
             p.in_stock_count, p.foreign_offer_count, p.price_updated_at, p.created_at,
             p.updated_at,
             pc.rule_version AS pc_rule_version, pc.state AS pc_state,
             pc.confidence AS pc_confidence, pc.brand_basis AS pc_brand_basis,
             pc.category_basis AS pc_category_basis, pb.name AS pc_brand_name,
             pcat.path AS pc_category_path, pc.compatible_brands AS pc_compatible,
             pc.wrote_brand AS pc_wrote_brand, pc.wrote_category AS pc_wrote_category,
             pc.detail AS pc_detail, pc.classified_at AS pc_classified_at
        FROM product p
        LEFT JOIN brand b ON b.id = p.brand_id
        LEFT JOIN category c ON c.id = p.category_id
        LEFT JOIN merchant sm ON sm.id = p.source_merchant_id
        LEFT JOIN product_classification pc ON pc.product_id = p.id
        LEFT JOIN brand pb ON pb.id = pc.brand_id
        LEFT JOIN category pcat ON pcat.id = pc.category_id
       WHERE p.id = ${productId}
    `);
    const row = result.rows[0];
    if (!row) return null;
    const sourceOfferId = row.source_offer_id === null ? null : Number(row.source_offer_id);

    const offers = await tx.execute<OfferSqlRow>(sql`
      SELECT ${OFFER_COLUMNS}
        FROM offer o JOIN merchant m ON m.id = o.merchant_id
       WHERE o.product_id = ${productId}
       ORDER BY o.is_active DESC, o.current_price ASC NULLS LAST, o.id
       LIMIT ${PANEL_OFFER_LIMIT + 1}
    `);
    const offerRows = offers.rows.slice(0, PANEL_OFFER_LIMIT).map((o) => toOffer(o, sourceOfferId));
    let sourceOffer = offerRows.find((o) => o.isSource) ?? null;
    if (!sourceOffer && sourceOfferId !== null) {
      // Kaynak teklif başka ürüne bağlanmış olabilir: kimlikle ayrıca okunur.
      const source = await tx.execute<OfferSqlRow>(sql`
        SELECT ${OFFER_COLUMNS}
          FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE o.id = ${sourceOfferId}
      `);
      sourceOffer = source.rows[0] ? toOffer(source.rows[0], sourceOfferId) : null;
    }

    return {
      id: Number(row.id),
      publicId: row.public_id,
      slug: row.slug,
      title: row.title,
      imageUrl: httpUrl(row.primary_image_url),
      gtin: row.gtin,
      brand:
        row.brand_id !== null && row.brand_name !== null
          ? { id: Number(row.brand_id), name: row.brand_name }
          : null,
      category:
        row.category_id !== null && row.category_path !== null
          ? {
              id: Number(row.category_id),
              path: row.category_path,
              name: row.category_name ?? row.category_path,
            }
          : null,
      publicationState: row.publication_state,
      holdReason: row.hold_reason,
      publishedAt: row.published_at ? new Date(row.published_at) : null,
      sourceMerchant:
        row.source_merchant_slug && row.source_merchant_name
          ? { slug: row.source_merchant_slug, name: row.source_merchant_name }
          : null,
      sourceExternalId: row.source_external_id,
      sourceOffer,
      offers: offerRows,
      offersTruncated: offers.rows.length > PANEL_OFFER_LIMIT,
      minPrice: row.min_price === null ? null : Number(row.min_price),
      offerCount: row.offer_count,
      inStockCount: row.in_stock_count,
      foreignOfferCount: row.foreign_offer_count,
      priceUpdatedAt: row.price_updated_at ? new Date(row.price_updated_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      classification:
        row.pc_state && row.pc_classified_at
          ? {
              ruleVersion: Number(row.pc_rule_version ?? 0),
              state: row.pc_state,
              confidence: Number(row.pc_confidence ?? 0),
              brandBasis: row.pc_brand_basis ?? "none",
              categoryBasis: row.pc_category_basis ?? "none",
              brandName: row.pc_brand_name,
              categoryPath: row.pc_category_path,
              compatibleBrands: row.pc_compatible ?? [],
              wroteBrand: Boolean(row.pc_wrote_brand),
              wroteCategory: Boolean(row.pc_wrote_category),
              detail: row.pc_detail,
              classifiedAt: new Date(row.pc_classified_at),
            }
          : null,
    };
  });
}

/* ----------------------------------------------------------------------- */
/* Sınıflandırma izleme                                                     */
/* ----------------------------------------------------------------------- */

export interface ClassificationCheckpoint {
  ruleVersion: number;
  scope: string;
  lastProductId: number;
  /** Bu kural sürümü + kapsamda taranan ürün (tüm yayın durumları; `--rescan` sıfırlar). */
  scanned: number;
  /** İşin YAZDIĞI marka / kategori sayısı (korunan mevcut değerler dahil değil). */
  brandSet: number;
  categorySet: number;
  review: number;
  errors: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface ClassificationJobRun {
  id: number;
  status: JobRunStatus;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorSummary: string | null;
}

/**
 * İşlem durumu (karar 0133). Kontrol noktası ve `job_run` birlikte okunur:
 * - `never`: hiç kontrol noktası yok.
 * - `running`: son koşu `running` ve kontrol noktası yakın zamanda ilerledi.
 * - `stalled`: koşu `running` ama kontrol noktası `STALL_AFTER_MS`'tir ilerlemiyor
 *   (WAL geri basıncı ya da takılma; koşu süreç ölünce de `running` kalabilir).
 * - `failed`: son koşu başarısız.
 * - `completed`: kontrol noktası tamamlandı (`completed_at`).
 * - `paused`: tamamlanmadı ve koşan iş yok (`--max-seconds`, WAL, elle durdurma).
 */
export type ClassificationRunStatus =
  | "never"
  | "running"
  | "stalled"
  | "failed"
  | "completed"
  | "paused";

export const STALL_AFTER_MS = 30 * 60 * 1000;

export function classificationRunStatus(
  checkpoint: Pick<ClassificationCheckpoint, "updatedAt" | "completedAt"> | null,
  lastRun: Pick<ClassificationJobRun, "status" | "startedAt"> | null,
  now: Date = new Date(),
): ClassificationRunStatus {
  if (lastRun?.status === "running") {
    const progressAt = Math.max(checkpoint?.updatedAt.getTime() ?? 0, lastRun.startedAt.getTime());
    const age = now.getTime() - progressAt;
    return age > Math.min(STALL_AFTER_MS, STUCK_JOB_AFTER_MS) ? "stalled" : "running";
  }
  if (!checkpoint) return lastRun?.status === "failed" ? "failed" : "never";
  if (lastRun?.status === "failed") return "failed";
  return checkpoint.completedAt ? "completed" : "paused";
}

export interface ClassificationMonitor {
  /** En yeni kural sürümünün `all` kontrol noktası (yönetim panelinin esas aldığı). */
  current: ClassificationCheckpoint | null;
  /** Tüm kontrol noktaları (en yeni sürüm önce; en çok 20). */
  checkpoints: ClassificationCheckpoint[];
  runs: ClassificationJobRun[];
  status: ClassificationRunStatus;
  /** Açık kanıt satırları, durum + ayrıntı kırılımı (`product_classification_open_idx`). */
  open: { state: "review" | "error"; detail: string | null; count: number }[];
  openReview: number;
  openErrors: number;
  /** Son işlenen ürün (kontrol noktası); silinmişse başlık `null`. */
  lastProduct: { id: number; title: string | null } | null;
  /** En yüksek ürün kimliği: kimlik aralığında ilerleme için (yaklaşık, kimlikler seyrek olabilir). */
  maxProductId: number | null;
}

type CheckpointSqlRow = {
  rule_version: number;
  scope: string;
  last_product_id: string;
  scanned: string;
  brand_set: string;
  category_set: string;
  review: string;
  errors: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

function toCheckpoint(row: CheckpointSqlRow): ClassificationCheckpoint {
  return {
    ruleVersion: Number(row.rule_version),
    scope: row.scope,
    lastProductId: Number(row.last_product_id),
    scanned: Number(row.scanned),
    brandSet: Number(row.brand_set),
    categorySet: Number(row.category_set),
    review: Number(row.review),
    errors: Number(row.errors),
    startedAt: new Date(row.started_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

/** Sınıflandırma izleme: yalnızca gerçek kayıtlar; tam tablo taraması yok. */
export async function getClassificationMonitor(
  db: Database,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<ClassificationMonitor> {
  assertCapability(actor, "catalog.read");
  return readOnly(db, 5_000, async (tx) => {
    const states = await tx.execute<CheckpointSqlRow>(sql`
      SELECT rule_version, scope, last_product_id, scanned, brand_set, category_set, review,
             errors, started_at, updated_at, completed_at
        FROM product_classification_state
       ORDER BY rule_version DESC, (scope = 'all') DESC, updated_at DESC
       LIMIT 20
    `);
    const checkpoints = states.rows.map(toCheckpoint);
    const current = checkpoints.find((c) => c.scope === "all") ?? null;

    const runs = await tx.execute<{
      id: string;
      status: JobRunStatus;
      trigger: string;
      started_at: string;
      finished_at: string | null;
      error_summary: string | null;
    }>(sql`
      SELECT id, status, trigger, started_at, finished_at, error_summary
        FROM job_run WHERE job = 'classify_products'
       ORDER BY started_at DESC LIMIT 5
    `);
    const runRows: ClassificationJobRun[] = runs.rows.map((r) => ({
      id: Number(r.id),
      status: r.status,
      trigger: r.trigger,
      startedAt: new Date(r.started_at),
      finishedAt: r.finished_at ? new Date(r.finished_at) : null,
      errorSummary: r.error_summary ? r.error_summary.slice(0, 300) : null,
    }));

    const open = await tx.execute<{ state: "review" | "error"; detail: string | null; n: string }>(
      sql`
        SELECT state, detail, count(*) AS n FROM product_classification
         WHERE state <> 'applied'
         GROUP BY state, detail ORDER BY state, count(*) DESC LIMIT 30
      `,
    );
    const openRows = open.rows.map((r) => ({
      state: r.state,
      detail: r.detail,
      count: Number(r.n),
    }));

    const max = await tx.execute<{ max_id: string | null }>(
      sql`SELECT max(id) AS max_id FROM product`,
    );
    let lastProduct: ClassificationMonitor["lastProduct"] = null;
    if (current && current.lastProductId > 0) {
      const last = await tx.execute<{ title: string }>(
        sql`SELECT title FROM product WHERE id = ${current.lastProductId}`,
      );
      lastProduct = { id: current.lastProductId, title: last.rows[0]?.title ?? null };
    }

    return {
      current,
      checkpoints,
      runs: runRows,
      status: classificationRunStatus(current, runRows[0] ?? null, now),
      open: openRows,
      openReview: openRows.filter((r) => r.state === "review").reduce((a, r) => a + r.count, 0),
      openErrors: openRows.filter((r) => r.state === "error").reduce((a, r) => a + r.count, 0),
      lastProduct,
      maxProductId: max.rows[0]?.max_id ? Number(max.rows[0].max_id) : null,
    };
  });
}

/** Filtre seçenekleri: mağazalar ve kategori ağacı (ikisi de küçük tablo). */
export async function listProductFilterOptions(
  db: Database,
  actor: AdminActor,
): Promise<{
  merchants: { slug: string; name: string; isActive: boolean }[];
  categories: { path: string; name: string; depth: number }[];
}> {
  assertCapability(actor, "catalog.read");
  return readOnly(db, 2_000, async (tx) => {
    const merchants = await tx.execute<{ slug: string; name: string; is_active: boolean }>(
      sql`SELECT slug, name, is_active FROM merchant ORDER BY is_active DESC, name LIMIT 500`,
    );
    const categories = await tx.execute<{ path: string; name: string }>(
      sql`SELECT path, name FROM category ORDER BY path LIMIT 1000`,
    );
    return {
      merchants: merchants.rows.map((m) => ({ slug: m.slug, name: m.name, isActive: m.is_active })),
      categories: categories.rows.map((c) => ({
        path: c.path,
        name: c.name,
        depth: c.path.split("/").length - 1,
      })),
    };
  });
}
