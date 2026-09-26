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
 * `scripts/orphans.ts` (CLI), `scripts/verify-schema.ts` (kapi) ve
 * `/yonetim/islemler` ayni sorguyu `src/health.ts`'ten alir — iki yerde
 * yasayan bir sorgu ayrisir.
 */
import type { Client } from "pg";
import { ORPHAN_SQL, type OrphanGroup, type OrphanRow, toOrphanGroup } from "../src/health.ts";

export { KNOWN_TARGET_TYPES, type OrphanGroup } from "../src/health.ts";

/**
 * Uyari uretmesi gereken gruplari dondurur. Bos dizi = beklenen durum.
 *
 * `target_type = 'query'` KASITLI olarak disaridadir: sema kullanici sorgusu
 * embedding'ine izin veriyor, karsilik gelen bir tablo yok. Yetim sayilamaz.
 */
export async function findOrphans(client: Client): Promise<OrphanGroup[]> {
  const { rows } = await client.query<OrphanRow>(ORPHAN_SQL);

  return rows.map(toOrphanGroup);
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
