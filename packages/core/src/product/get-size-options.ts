import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import type { SizeOption } from "./result-types.ts";

type RawRow = Record<string, unknown> & {
  size_norm: string;
  size_label: string | null;
  in_stock: boolean;
};

const LETTER_SIZE_RANK: Record<string, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4, xxl: 5 };

function sortSizeOptions(options: readonly SizeOption[]): SizeOption[] {
  const allNumeric = options.every((option) => Number.isFinite(Number(option.sizeNorm)));
  if (allNumeric) {
    return [...options].sort((a, b) => Number(a.sizeNorm) - Number(b.sizeNorm));
  }
  return [...options].sort((a, b) => {
    const rankA = LETTER_SIZE_RANK[a.sizeNorm] ?? Number.POSITIVE_INFINITY;
    const rankB = LETTER_SIZE_RANK[b.sizeNorm] ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return a.sizeNorm.localeCompare(b.sizeNorm, "tr");
  });
}

/**
 * docs/pages.md "Beden secici": beden `offer_variant`de, urun degil teklif
 * bazinda. Ayni beden farkli tekliflerde farkli stok durumunda olabilir -
 * en az bir teklifte stoktaysa "mevcut" sayilir (bool_or).
 */
export async function getSizeOptions(db: Database, productId: number): Promise<SizeOption[]> {
  const result = await db.execute<RawRow>(sql`
    SELECT ov.size_norm, MIN(ov.size_label) AS size_label, bool_or(ov.in_stock) AS in_stock
    FROM offer_variant ov
    JOIN offer o ON o.id = ov.offer_id
    WHERE o.product_id = ${productId} AND o.is_active AND ov.size_norm IS NOT NULL
    GROUP BY ov.size_norm
  `);

  const options = result.rows.map((row) => ({
    sizeNorm: row.size_norm,
    sizeLabel: row.size_label,
    inStock: row.in_stock,
  }));

  return sortSizeOptions(options);
}
