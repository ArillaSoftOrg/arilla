/**
 * Urun detay galerisi (karar 0073). Gorseller offer'dan gelir; urun galerisi
 * okuma aninda tek offer'in `display_rank` verilmis gorsellerinden kurulur
 * (model cagrisi yok, hesaplama yok - yalnizca okuma).
 *
 * Hangi offer: once urunun eski `primary_image_url`inin geldigi offer (liste
 * kartiyla ayni gorselle baslamak icin), sonra stokta olan, sonra en ucuz.
 * Offer'in gosterilecek gorseli yoksa siradaki offer denenir.
 *
 * Geri donus: gallery kaydi yoksa `primary_image_url` tek gorsel olarak doner;
 * o da yoksa bos (arayuz yer tutucu gosterir).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { MAX_DISPLAY_IMAGES, pickImageUrl } from "../media/gallery-config.ts";
import type { GalleryImage, ProductGallery } from "./result-types.ts";

export interface GalleryRow {
  offerId: number;
  sourceUrl: string;
  r2Url: string | null;
  width: number | null;
  height: number | null;
  isVariantSpecific: boolean;
}

/** Saf birlestirme: satirlar (display_rank sirali) + eski gorsel -> galeri. */
export function buildGallery(
  rows: readonly GalleryRow[],
  legacyPrimaryUrl: string | null,
): ProductGallery {
  const images: GalleryImage[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const url = pickImageUrl({ r2Url: row.r2Url, sourceUrl: row.sourceUrl });
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    images.push({
      url,
      width: row.width,
      height: row.height,
      sourceOfferId: row.offerId,
      isVariantSpecific: row.isVariantSpecific,
    });
    if (images.length >= MAX_DISPLAY_IMAGES) break;
  }
  if (images.length > 0) return { images, source: "gallery" };

  const legacy = pickImageUrl({ legacyUrl: legacyPrimaryUrl });
  if (legacy !== null) {
    return {
      images: [
        { url: legacy, width: null, height: null, sourceOfferId: null, isVariantSpecific: false },
      ],
      source: "legacy",
    };
  }
  return { images: [], source: "none" };
}

export async function getProductGallery(
  db: Database,
  productId: number,
  legacyPrimaryUrl: string | null,
): Promise<ProductGallery> {
  const result = await db.execute(sql`
    WITH chosen AS (
      SELECT o.id
      FROM offer o
      JOIN product p ON p.id = o.product_id
      WHERE o.product_id = ${productId}
        AND o.is_active
        AND EXISTS (
          SELECT 1 FROM offer_image oi
          WHERE oi.offer_id = o.id AND oi.status = 'active' AND oi.display_rank IS NOT NULL
        )
      ORDER BY (o.image_url IS NOT DISTINCT FROM p.primary_image_url) DESC,
               o.in_stock DESC,
               o.current_price ASC NULLS LAST,
               o.id ASC
      LIMIT 1
    )
    SELECT oi.offer_id, oi.source_url, oi.r2_url, oi.width, oi.height, oi.is_variant_specific
    FROM offer_image oi
    JOIN chosen c ON c.id = oi.offer_id
    WHERE oi.status = 'active' AND oi.display_rank IS NOT NULL
    ORDER BY oi.display_rank ASC
    LIMIT ${MAX_DISPLAY_IMAGES}
  `);

  const rows: GalleryRow[] = result.rows.map((row) => ({
    offerId: Number(row.offer_id),
    sourceUrl: String(row.source_url),
    r2Url: row.r2_url === null ? null : String(row.r2_url),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    isVariantSpecific: Boolean(row.is_variant_specific),
  }));
  return buildGallery(rows, legacyPrimaryUrl);
}
