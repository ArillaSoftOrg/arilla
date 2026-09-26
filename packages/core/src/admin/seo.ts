/**
 * `/yonetim/seo` (Faz 7): Arilla'nın KENDİ verisinden iç SEO tanısı.
 *
 * Google Search Console verisi DEĞİLDİR ve öyle gösterilmez: burada tarama,
 * dizine ekleme, tıklama ya da gösterim sayısı yoktur. Yalnızca bizim
 * sitemap/indekslenebilirlik kuralımızın (`sitemap-eligibility.ts`) ve
 * katalog alanlarının durumu vardır.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import {
  countSitemapEligibleByShard,
  SITEMAP_PRODUCT_SHARD_SIZE,
  type SitemapShardEligibility,
} from "../product/sitemap-eligibility.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

const SAMPLE_SIZE = 10;

export interface SeoSample {
  id: number;
  slug: string;
  title: string;
}

export interface SeoDiagnostics {
  generatedAt: Date;
  products: {
    total: number;
    missingImage: number;
    missingBrand: number;
    missingPrice: number;
    missingCategory: number;
    /** Kategorisi `is_discoverable = false`: sitemap'e ve keşfete girmez (bilerek). */
    nonDiscoverableCategory: number;
    /** Tek teklifli: sitemap için 14 gün fiyat geçmişi bekler. */
    singleOffer: number;
    noOffers: number;
  };
  samples: { missingImage: SeoSample[]; missingBrand: SeoSample[]; missingPrice: SeoSample[] };
  sitemap: {
    maxProductId: number;
    shardSize: number;
    shardCount: number;
    shards: SitemapShardEligibility[];
    eligibleTotal: number;
  } | null;
  slugHistory: {
    total: number;
    /** Eski slug başka bir CANLI ürünün slug'ı: yönlendirme o ürünü gölgeler. */
    conflicts: number;
    recent: { oldSlug: string; currentSlug: string; productId: number; createdAt: Date }[];
  };
}

type SampleRow = { id: string; slug: string; title: string };

export async function getSeoDiagnostics(db: Database, actor: AdminActor): Promise<SeoDiagnostics> {
  assertCapability(actor, "catalog.read");

  const base = await readOnly(db, 5_000, async (tx) => {
    const counts = await tx.execute<Record<string, string>>(sql`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE p.primary_image_url IS NULL) AS missing_image,
             count(*) FILTER (WHERE p.brand_id IS NULL) AS missing_brand,
             count(*) FILTER (WHERE p.min_price IS NULL) AS missing_price,
             count(*) FILTER (WHERE p.category_id IS NULL) AS missing_category,
             count(*) FILTER (WHERE c.is_discoverable IS FALSE) AS non_discoverable,
             count(*) FILTER (WHERE p.offer_count = 1) AS single_offer,
             count(*) FILTER (WHERE p.offer_count = 0) AS no_offers,
             coalesce(max(p.id), 0) AS max_id
        FROM product p LEFT JOIN category c ON c.id = p.category_id
    `);
    const sample = async (condition: ReturnType<typeof sql>) =>
      (
        await tx.execute<SampleRow>(sql`
          SELECT p.id, p.slug, p.title FROM product p
           WHERE ${condition} ORDER BY p.id DESC LIMIT ${SAMPLE_SIZE}
        `)
      ).rows.map((row) => ({ id: Number(row.id), slug: row.slug, title: row.title }));
    const samples = {
      missingImage: await sample(sql`p.primary_image_url IS NULL`),
      missingBrand: await sample(sql`p.brand_id IS NULL`),
      missingPrice: await sample(sql`p.min_price IS NULL`),
    };
    const slugs = await tx.execute<{ total: string; conflicts: string }>(sql`
      SELECT (SELECT count(*) FROM product_slug_history) AS total,
             (SELECT count(*) FROM product_slug_history h
                JOIN product p ON p.slug = h.slug AND p.id <> h.product_id) AS conflicts
    `);
    const recent = await tx.execute<{
      slug: string;
      current_slug: string;
      product_id: string;
      created_at: string;
    }>(sql`
      SELECT h.slug, p.slug AS current_slug, h.product_id, h.created_at
        FROM product_slug_history h JOIN product p ON p.id = h.product_id
       ORDER BY h.created_at DESC LIMIT 10
    `);
    return { counts: counts.rows[0] ?? {}, samples, slugs: slugs.rows[0], recent: recent.rows };
  });

  // Uygunluk koşulu tek teklifli ürünlerde fiyat geçmişine bakar: ayrı ve
  // daha uzun sınırlı işlemde; zaman aşımında sitemap bölümü boş döner.
  let shards: SitemapShardEligibility[] | null = null;
  try {
    shards = await readOnly(db, 10_000, (tx) =>
      countSitemapEligibleByShard(tx as unknown as Database),
    );
  } catch {
    shards = null;
  }

  const n = (key: string) => Number(base.counts[key] ?? 0);
  const maxProductId = n("max_id");
  return {
    generatedAt: new Date(),
    products: {
      total: n("total"),
      missingImage: n("missing_image"),
      missingBrand: n("missing_brand"),
      missingPrice: n("missing_price"),
      missingCategory: n("missing_category"),
      nonDiscoverableCategory: n("non_discoverable"),
      singleOffer: n("single_offer"),
      noOffers: n("no_offers"),
    },
    samples: base.samples,
    sitemap: shards
      ? {
          maxProductId,
          shardSize: SITEMAP_PRODUCT_SHARD_SIZE,
          shardCount: Math.max(1, Math.ceil(maxProductId / SITEMAP_PRODUCT_SHARD_SIZE)),
          shards,
          eligibleTotal: shards.reduce((sum, shard) => sum + shard.eligible, 0),
        }
      : null,
    slugHistory: {
      total: Number(base.slugs?.total ?? 0),
      conflicts: Number(base.slugs?.conflicts ?? 0),
      recent: base.recent.map((row) => ({
        oldSlug: row.slug,
        currentSlug: row.current_slug,
        productId: Number(row.product_id),
        createdAt: new Date(row.created_at),
      })),
    },
  };
}
