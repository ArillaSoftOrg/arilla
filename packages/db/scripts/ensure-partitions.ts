/**
 * `price_point` aylik partition uretimi.
 *
 * Hem ileriye donuk bakim (`partitions.ts`) hem de gecmise donuk tohum verisi
 * (`seed.ts`) ayni islevi kullanir: iki yerde iki farkli partition mantigi
 * olursa biri digerinden sessizce ayrisir.
 */
import type { Client } from "pg";

/** Ayin ilk gunu, YYYY-MM-01. Aralik -> Ocak devri Date.UTC ile dogru islenir. */
export function monthStart(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function partitionName(date: Date): string {
  return `price_point_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * `from` ve `to` tarihlerinin ait oldugu aylar dahil, aradaki her ay icin
 * partition olusturur. Idempotent: var olan ay atlanir.
 *
 * Yeni partition'lara `arilla_app` yetkisi VERILMEZ — partitioned tabloya
 * INSERT'te yetki ebeveyn uzerinde denetlenir, partition'a dogrudan erisim
 * gerekmez. Bkz. migrations/0010_append_only_grants.sql.
 */
export async function ensureMonthlyPartitions(
  client: Client,
  from: Date,
  to: Date,
): Promise<string[]> {
  const created: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

  while (cursor.getTime() <= last.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const name = partitionName(cursor);

    const { rowCount } = await client.query("SELECT 1 FROM pg_class WHERE relname = $1", [name]);
    if (rowCount === 0) {
      await client.query(
        `CREATE TABLE ${name} PARTITION OF price_point
           FOR VALUES FROM ('${monthStart(year, month)}') TO ('${monthStart(year, month + 1)}')`,
      );
      await client.query(`REVOKE ALL ON ${name} FROM arilla_app`);
      created.push(name);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return created;
}
