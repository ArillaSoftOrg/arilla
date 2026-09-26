/**
 * Saglik denetimi sorgulari: CLI betikleri (`scripts/*`) ve
 * `/yonetim/islemler` ayni SQL'i buradan alir. Yalnizca OKUMA; uygulama
 * rolu (`arilla_app`) ile calisir.
 */

/** Tanimli hedef turleri. `query` bir tabloya isaret etmez; bkz. asagisi. */
export const KNOWN_TARGET_TYPES = ["offer", "product", "query"] as const;

export interface OrphanGroup {
  tablo: string;
  targetType: string;
  /** `yetim`: hedef tur tanimli ama satir yok. `tanimsiz_tur`: tur bilinmiyor. */
  sebep: "yetim" | "tanimsiz_tur";
  adet: number;
}

export const ORPHAN_SQL = `
WITH polimorfik AS (
    SELECT 'embedding'         AS tablo, target_type, target_id FROM embedding
    UNION ALL
    SELECT 'generated_content' AS tablo, target_type, target_id FROM generated_content
)
SELECT tablo,
       target_type,
       CASE WHEN target_type IN ('offer','product') THEN 'yetim' ELSE 'tanimsiz_tur' END AS sebep,
       count(*)::text AS adet
  FROM polimorfik p
 WHERE (p.target_type = 'offer'
        AND NOT EXISTS (SELECT 1 FROM offer o WHERE o.id = p.target_id))
    OR (p.target_type = 'product'
        AND NOT EXISTS (SELECT 1 FROM product pr WHERE pr.id = p.target_id))
    OR p.target_type NOT IN ('offer','product','query')
 GROUP BY 1, 2, 3
 ORDER BY 1, 2
`;

export interface OrphanRow {
  tablo: string;
  target_type: string;
  sebep: string;
  adet: string;
}

export function toOrphanGroup(row: OrphanRow): OrphanGroup {
  return {
    tablo: row.tablo,
    targetType: row.target_type,
    sebep: row.sebep as OrphanGroup["sebep"],
    adet: Number(row.adet),
  };
}
