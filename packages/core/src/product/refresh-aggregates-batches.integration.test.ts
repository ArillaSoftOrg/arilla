/**
 * Fiyat özetinin partili yenilenmesi (migration 0083): mağaza aç/kapat ve günlük
 * onarım ürünleri kendi işlemlerinde partiler halinde yeniler. Mağazanın ürünleri
 * aktif ve pasif teklifler için iki ayrı sıralı listeden birleşir; küçük parti
 * boyunda bile hiçbir ürün atlanmamalı.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { refreshMerchantAggregates, refreshProductAggregates } from "./refresh-aggregates.ts";

const suffix = `agb-${Date.now()}`;

describe("fiyat özeti: partili yenileme", () => {
  let db: Database;
  let merchantId = 0;
  let otherMerchantId = 0;
  const productIds: number[] = [];
  let otherProductId = 0;

  const corrupt = () =>
    withOwnerClient((client) =>
      client.query("UPDATE product SET offer_count = 9, min_price = 1 WHERE id = ANY($1)", [
        [...productIds, otherProductId],
      ]),
    );
  const summaries = (ids: number[]) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        "SELECT id, offer_count, min_price::int AS min_price FROM product WHERE id = ANY($1) ORDER BY id",
        [ids],
      );
      return res.rows.map((row) => [row.offer_count, row.min_price]);
    });

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string) =>
        Number(
          (
            await client.query(
              `INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES ($1, $1, $2, 'xml_feed', TRUE) RETURNING id`,
              [`${suffix}-${key}`, `${suffix}-${key}.test`],
            )
          ).rows[0].id,
        );
      merchantId = await merchant("m");
      otherMerchantId = await merchant("o");
      const product = async (n: number) =>
        Number(
          (
            await client.query(
              "INSERT INTO product (slug, title) VALUES ($1, 'AGB') RETURNING id",
              [`${suffix}-${n}`],
            )
          ).rows[0].id,
        );
      let ext = 0;
      const offer = (merchant: number, productId: number, price: number, active: boolean) =>
        client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                              in_stock, is_active)
           VALUES ($1, $2, $3, $4, 'AGB', $5, TRUE, $6)`,
          [
            merchant,
            productId,
            `${suffix}-${++ext}`,
            `https://${suffix}.test/${ext}`,
            price,
            active,
          ],
        );
      // 7 ürün: 1-3 ve 7 aktif teklifli, 4-6 yalnızca pasif teklifli (iki listenin
      // kimlikleri iç içe değil: kısa parti, bir listenin ortasındaki ürünü atlatabilirdi);
      // birinde iki teklif.
      for (let n = 1; n <= 7; n++) {
        const id = await product(n);
        productIds.push(id);
        await offer(merchantId, id, 1000 * n, [1, 2, 3, 7].includes(n));
        if (n === 3) await offer(merchantId, id, 500, true);
      }
      otherProductId = await product(99);
      await offer(otherMerchantId, otherProductId, 4200, true);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [
        [merchantId, otherMerchantId],
      ]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [
        [...productIds, otherProductId],
      ]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [
        [merchantId, otherMerchantId],
      ]);
    });
  });

  it("mağazanın tüm ürünleri (aktif + pasif teklifli) küçük partilerde atlanmadan yenilenir", async () => {
    for (const batchSize of [1, 2, 3, 1000]) {
      await corrupt();
      const result = await refreshMerchantAggregates(db, merchantId, { batchSize });
      expect(result).toEqual({ updated: 7, pending: false });
      expect(await summaries(productIds)).toEqual([
        [1, 1000],
        [1, 2000],
        [1, 500],
        [0, null],
        [0, null],
        [0, null],
        [1, 7000],
      ]);
      // Başka mağazanın ürünü kapsam dışı: bozuk kalır.
      expect(await summaries([otherProductId])).toEqual([[9, 1]]);
    }
  });

  it("süre bitince yeni parti başlamaz; pending döner, kalan sonraki koşuya kalır", async () => {
    await corrupt();
    let clock = 0;
    const result = await refreshMerchantAggregates(db, merchantId, {
      batchSize: 2,
      budgetMs: 10,
      now: () => {
        const value = clock;
        clock += 6;
        return value;
      },
    });
    // started=0, 1. kontrol 6 (<10) -> 1 parti, 2. kontrol 12 (>=10) -> dur.
    expect(result).toEqual({ updated: 2, pending: true });
    const done = await refreshMerchantAggregates(db, merchantId);
    expect(done).toEqual({ updated: 5, pending: false });
  });

  it("fonksiyon: boş ve bilinmeyen kimlik 0 döner; tekrar 0 satır yazar", async () => {
    expect(await refreshProductAggregates(db, { productIds: [] })).toBe(0);
    const unknown = await db.execute<{ n: number }>(
      sql`SELECT refresh_product_aggregates(ARRAY[-1]::bigint[]) AS n`,
    );
    expect(Number(unknown.rows[0]?.n)).toBe(0);
    await refreshProductAggregates(db, { productIds: productIds });
    expect(await refreshProductAggregates(db, { productIds: productIds })).toBe(0);
  });
});
