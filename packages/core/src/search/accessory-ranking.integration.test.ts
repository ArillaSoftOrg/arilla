/**
 * Karar 0197: ana urun sorgusunda aksesuar basligi, fiyat avantajina ragmen ana urunun onune gecmez
 * (iki sekmede de); kullanici aksesuar istiyorsa ya da aksesuar tek sonucsa hicbir sey elenmez.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { search } from "./search.ts";
import { CANDIDATE_LIMIT } from "./text-match.ts";
import type { QueryObject } from "./types.ts";

const tag = `zxqtel${Date.now().toString(36).replace(/[0-9]/g, "k")}`;

function query(text: string, sort: QueryObject["sort"]): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text,
    filters: {},
    style_tags: [],
    sort,
    unparsed: text,
    confidence: 1,
  };
}

describe("accessory demotion in text ranking", () => {
  let db: Database;
  const ids: number[] = [];
  let merchantId = 0;
  let mainId = 0;
  let caseId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Aksesuar Testi', $2, 'xml_feed') RETURNING id`,
        [`acc-${tag}`, `acc-${tag}.example.test`],
      );
      merchantId = Number(m.rows[0].id);
      const add = async (title: string, price: number, percentile: number): Promise<number> => {
        const key = `${tag}-${ids.length}`;
        const p = await client.query(
          `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           VALUES ($1, $2, $3, $3, 1, 1) RETURNING id`,
          [key, title, price],
        );
        const id = Number(p.rows[0].id);
        ids.push(id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $6, $5, TRUE, TRUE)`,
          [merchantId, id, key, `https://acc-${tag}.example.test/${key}`, price, title],
        );
        await client.query(
          `INSERT INTO product_price_stats (product_id, current_percentile, list_price_inflated)
           VALUES ($1, $2, FALSE)`,
          [id, percentile],
        );
        return id;
      };
      // Aksesuar: cok ucuz ve en iyi yuzdelikte; ana urun pahali.
      caseId = await add(`${tag} 15 Silikon Kılıf`, 20_000, 1);
      mainId = await add(`Apple ${tag} 15 128 GB`, 3_500_000, 90);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM product_price_stats WHERE product_id = ANY($1)", [ids]);
      await client.query("DELETE FROM offer WHERE product_id = ANY($1)", [ids]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [ids]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    });
  });

  const order = async (text: string, sort: QueryObject["sort"]) =>
    (await search(db, query(text, sort), { limit: 20 })).items.map((i) => i.productId);

  for (const sort of ["balanced", "best_deal"] as const) {
    it(`${sort}: ana urun aksesuarin onunde, aksesuar elenmez`, async () => {
      const got = await order(`${tag} 15`, sort);
      expect(got).toContain(caseId);
      expect(got.indexOf(mainId)).toBeGreaterThanOrEqual(0);
      expect(got.indexOf(mainId)).toBeLessThan(got.indexOf(caseId));
    });
  }

  it("kullanici aksesuar istiyorsa aksesuar sonuctur", async () => {
    expect(await order(`${tag} kılıf`, "balanced")).toContain(caseId);
  });

  it("hediye/kilifli ana urun aksesuar sayilmaz, uyumlu kilif sayilir", async () => {
    const [giftId, caseOnlyId] = await withOwnerClient(async (client) => {
      const out: number[] = [];
      for (const [title, price, pct] of [
        [`Apple ${tag} 16 + Kılıf Hediyeli 256 GB`, 4_000_000, 95],
        [`${tag} 16 Uyumlu Şeffaf Kılıf`, 10_000, 1],
      ] as const) {
        const key = `${tag}-g${out.length}`;
        const p = await client.query(
          `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           VALUES ($1, $2, $3, $3, 1, 1) RETURNING id`,
          [key, title, price],
        );
        const id = Number(p.rows[0].id);
        ids.push(id);
        out.push(id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $6, $5, TRUE, TRUE)`,
          [merchantId, id, key, `https://acc-${tag}.example.test/${key}`, price, title],
        );
        await client.query(
          `INSERT INTO product_price_stats (product_id, current_percentile, list_price_inflated)
           VALUES ($1, $2, FALSE)`,
          [id, pct],
        );
      }
      return out as [number, number];
    });
    for (const sort of ["balanced", "best_deal"] as const) {
      const got = await order(`${tag} 16`, sort);
      expect(got.indexOf(giftId)).toBeGreaterThanOrEqual(0);
      expect(got.indexOf(giftId)).toBeLessThan(got.indexOf(caseOnlyId));
    }
  });

  it("dogrulanmis model rolu accessory ise kademe uygulanmaz (acik soz yok)", async () => {
    const q = { ...query(`${tag} 15`, "balanced"), product_role: "accessory" as const };
    const got = (await search(db, q, { limit: 20 })).items.map((i) => i.productId);
    expect(got.indexOf(caseId)).toBeLessThan(got.indexOf(mainId));
  });

  it("aksesuar seli ana urunu aday havuzundan itmez", async () => {
    const floodTag = `${tag}sel`;
    const flood = CANDIDATE_LIMIT * 3;
    const floodMainId = await withOwnerClient(async (client) => {
      await client.query(
        `WITH p AS (
           INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           SELECT $1 || '-' || g, $1 || ' 15 Uyumlu Kılıf ' || g, 1000, 1000, 1, 1
             FROM generate_series(1, $2::int) g RETURNING id, title)
         INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                            current_price, is_active, in_stock)
         SELECT $3, id, $1 || '-o-' || id, 'https://acc-' || $1 || '.example.test/' || id,
                title, 1000, TRUE, TRUE FROM p`,
        [floodTag, flood, merchantId],
      );
      const m = await client.query(
        `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
         VALUES ($1, $2, 5000000, 5000000, 1, 1) RETURNING id`,
        [`${floodTag}-main`, `Apple ${floodTag} 15 128 GB`],
      );
      const id = Number(m.rows[0].id);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                            current_price, is_active, in_stock)
         VALUES ($1, $2, $3, $4, $5, 5000000, TRUE, TRUE)`,
        [merchantId, id, `${floodTag}-m`, `https://acc-${tag}.example.test/${floodTag}-m`, "Apple"],
      );
      return id;
    });
    try {
      const got = (await search(db, query(`${floodTag} 15`, "balanced"), { limit: 20 })).items;
      expect(got[0]?.productId).toBe(floodMainId);
    } finally {
      await withOwnerClient(async (client) => {
        await client.query(
          "DELETE FROM offer WHERE product_id IN (SELECT id FROM product WHERE slug LIKE $1)",
          [`${floodTag}-%`],
        );
        await client.query("DELETE FROM product WHERE slug LIKE $1", [`${floodTag}-%`]);
      });
    }
  });

  it("baska urun turlerinde ana urun olan basliklar (kemer kayis, guneş koruyucu) kademeye girmez", async () => {
    const kTag = `${tag}kmr`;
    const [cheapId, dearId] = await withOwnerClient(async (client) => {
      const out: number[] = [];
      for (const [title, price, pct] of [
        [`${kTag} Hakiki Deri Erkek Kemer Kayış`, 20_000, 1],
        [`${kTag} Klasik Kemer`, 90_000, 90],
      ] as const) {
        const key = `${kTag}-${out.length}`;
        const p = await client.query(
          `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           VALUES ($1, $2, $3, $3, 1, 1) RETURNING id`,
          [key, title, price],
        );
        const id = Number(p.rows[0].id);
        ids.push(id);
        out.push(id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $6, $5, TRUE, TRUE)`,
          [merchantId, id, key, `https://acc-${tag}.example.test/${key}`, price, title],
        );
        await client.query(
          `INSERT INTO product_price_stats (product_id, current_percentile, list_price_inflated)
           VALUES ($1, $2, FALSE)`,
          [id, pct],
        );
      }
      return out as [number, number];
    });
    for (const sort of ["balanced", "best_deal"] as const) {
      const got = await order(`${kTag} kemer`, sort);
      // Ucuz/iyi fiyatli kayisli kemer demote edilmediginden once gelir.
      expect(got.indexOf(cheapId)).toBeGreaterThanOrEqual(0);
      expect(got.indexOf(cheapId)).toBeLessThan(got.indexOf(dearId));
    }
  });
});
