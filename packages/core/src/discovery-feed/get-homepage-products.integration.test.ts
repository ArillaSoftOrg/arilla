import type { Database } from "@arilla/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { withOwnerClient } from "../test-db.ts";
import { getHomepageProducts } from "./get-homepage-products.ts";

it("ana sayfaya yalnizca yayinda ve alinabilir gercek urunleri guncel fiyatla getirir", async () => {
  await withOwnerClient(async (client) => {
    await client.query("BEGIN");
    try {
      const key = `home-${Date.now()}`;
      const merchant = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Homepage test', $2, 'xml_feed') RETURNING id`,
        [key, `${key}.test`],
      );
      const category = await client.query(
        `INSERT INTO category (slug, name, path, is_discoverable)
         VALUES ($1, 'Homepage test', $1, true), ($2, 'Hidden', $2, false) RETURNING id`,
        [key, `${key}-hidden`],
      );
      const ids: number[] = [];
      for (const kind of ["valid", "draft", "no-image", "inactive", "hidden"]) {
        const row = await client.query(
          `INSERT INTO product
            (slug,title,category_id,publication_state,primary_image_url,min_price,offer_count,
             source_merchant_id,source_external_id)
           VALUES ($1,$2,$3,$4,$5,100,1,$6,$7) RETURNING id`,
          [
            `${key}-${kind}`,
            kind,
            category.rows[kind === "hidden" ? 1 : 0].id,
            kind === "draft" ? "draft" : "published",
            kind === "no-image" ? null : "https://img.test/home.png",
            merchant.rows[0].id,
            kind,
          ],
        );
        const id = Number(row.rows[0].id);
        ids.push(id);
        await client.query(
          `INSERT INTO offer
            (merchant_id,product_id,external_id,url,title_raw,current_price,in_stock,is_active)
           VALUES ($1,$2,$3,$4,$5,200,TRUE,$6)`,
          [merchant.rows[0].id, id, kind, `https://${key}.test/${kind}`, kind, kind !== "inactive"],
        );
      }
      const db = drizzle(client) as unknown as Database;
      const items = await getHomepageProducts(db, "2026-11-01", 20);
      const included = items.filter((item) => ids.includes(item.productId));
      expect(included.map((item) => item.productId)).toEqual([ids[0]]);
      expect(included[0]?.minPrice).toBe(200); // eski aggregate 100 degil, etkin teklif
      expect(items).toEqual(await getHomepageProducts(db, "2026-11-01", 20));
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
