/**
 * Polimorfik `target_id` icin yetim tespiti.
 *
 * `embedding` ve `generated_content` tablolarinda `target_id` bir foreign key
 * DEGILDIR (`target_type`'a gore offer/product/query gosterir), yani Postgres
 * bu iki tabloda referans butunlugu SAGLAMAZ. Migration 0014 silme yonunu
 * trigger ile kapatti; bu modul trigger'in kapatmadigi yollari olcer:
 *
 *   1. Yazma yonu — var olmayan bir `target_id` ile INSERT.
 *   2. `DISABLE TRIGGER` ya da `session_replication_role = replica`.
 *   3. `generated_content.target_type` SERBEST TEXT'tir (`embedding`'in
 *      aksine CHECK kisiti yok): "ofer" yazimi hem trigger'dan hem de naif
 *      bir yetim sorgusundan kacardi. O yuzden taninmayan tur de sayilir.
 *
 * `scripts/orphans.ts` (CLI) ve `scripts/verify-schema.ts` (kapi) ayni
 * sorguyu buradan alir — iki yerde yasayan bir sorgu ayrisir.
 */
import type { Client } from "pg";

/** Tanimli hedef turleri. `query` bir tabloya isaret etmez; bkz. asagisi. */
export const KNOWN_TARGET_TYPES = ["offer", "product", "query"] as const;

export interface OrphanGroup {
  tablo: string;
  targetType: string;
  /** `yetim`: hedef tur tanimli ama satir yok. `tanimsiz_tur`: tur bilinmiyor. */
  sebep: "yetim" | "tanimsiz_tur";
  adet: number;
}

const ORPHAN_SQL = `
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

/**
 * Uyari uretmesi gereken gruplari dondurur. Bos dizi = beklenen durum.
 *
 * `target_type = 'query'` KASITLI olarak disaridadir: sema kullanici sorgusu
 * embedding'ine izin veriyor, karsilik gelen bir tablo yok. Yetim sayilamaz.
 */
export async function findOrphans(client: Client): Promise<OrphanGroup[]> {
  const { rows } = await client.query<{
    tablo: string;
    target_type: string;
    sebep: string;
    adet: string;
  }>(ORPHAN_SQL);

  return rows.map((row) => ({
    tablo: row.tablo,
    targetType: row.target_type,
    sebep: row.sebep as OrphanGroup["sebep"],
    adet: Number(row.adet),
  }));
}

/** Bilgi amacli: sorgu embedding'leri. Uyari uretmez, gorunur olsun diye. */
export async function countQueryScoped(client: Client): Promise<number> {
  const { rows } = await client.query<{ adet: string }>(
    `SELECT (
        (SELECT count(*) FROM embedding         WHERE target_type = 'query') +
        (SELECT count(*) FROM generated_content WHERE target_type = 'query')
     )::text AS adet`,
  );
  return Number(rows[0]?.adet ?? "0");
}

export function totalOrphans(groups: OrphanGroup[]): number {
  return groups.reduce((sum, group) => sum + group.adet, 0);
}
