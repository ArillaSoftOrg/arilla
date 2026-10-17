/**
 * `bestOfferJoin`: urun basina okuma (`lateral`) ile tek gecis (`scan`) ayni
 * teklifi secer. Arama sorgunun bicimine gore yol degistirir (`bestOfferStrategy`);
 * kart fiyati, skor ve filtre yoldan bagimsiz olmali.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type BestOfferScope, bestOfferJoin, bestOfferStrategy } from "./search-sql.ts";

interface OfferFixture {
  merchant: "a" | "b" | "off";
  price: number | null;
  currency?: string;
  inStock?: boolean;
  active?: boolean;
}

/** Urun basina teklifler: her satir bir kenar durumu. */
const PRODUCTS: OfferFixture[][] = [
  [
    { merchant: "a", price: 500 },
    { merchant: "b", price: 300 },
  ],
  // En ucuz teklif pasif magazada / USD / pasif: sayilmaz.
  [
    { merchant: "off", price: 100 },
    { merchant: "a", price: 900, currency: "USD" },
    { merchant: "b", price: 50, active: false },
    { merchant: "a", price: 700 },
  ],
  // En ucuz stokta degil: `inStockOnly` ile ikinci secilir.
  [
    { merchant: "a", price: 200, inStock: false },
    { merchant: "b", price: 400 },
  ],
  // Fiyatsiz teklif fiyatlinin ARDINDAN (NULLS LAST); yalniz fiyatsizsa o secilir.
  [
    { merchant: "a", price: null },
    { merchant: "b", price: 800 },
  ],
  [{ merchant: "a", price: null }],
  // Gecerli teklifi yok: `inner` eler, `left` NULL birakir.
  [{ merchant: "off", price: 100 }],
  [],
];

describe("bestOfferJoin: lateral ve scan ayni teklifi secer", () => {
  const suffix = `bo-${Date.now()}`;
  let db: Database;
  const merchants: Record<string, number> = {};
  const productIds: number[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      for (const [key, active] of [
        ["a", true],
        ["b", true],
        ["off", false],
      ] as const) {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $2, $3, 'xml_feed', $4, 70) RETURNING id`,
          [`${key}-${suffix}`, `BO ${key}`, `${key}-${suffix}.example.test`, active],
        );
        merchants[key] = Number(row.rows[0].id);
      }
      let n = 0;
      for (const offers of PRODUCTS) {
        const row = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, 'BO test') RETURNING id",
          [`${suffix}-${productIds.length}`],
        );
        const productId = Number(row.rows[0].id);
        productIds.push(productId);
        for (const offer of offers) {
          n++;
          await client.query(
            `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                                currency, in_stock, is_active)
             VALUES ($1, $2, $3, $4, 'BO', $5, $6, $7, $8)`,
            [
              merchants[offer.merchant],
              productId,
              `${suffix}-${n}`,
              `https://${suffix}.test/${n}`,
              offer.price,
              offer.currency ?? "TRY",
              offer.inStock ?? true,
              offer.active ?? true,
            ],
          );
        }
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE product_id = ANY($1)", [productIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [Object.values(merchants)]);
    });
  });

  async function pick(
    scope: BestOfferScope,
    mode: "inner" | "left",
    strategy: "lateral" | "scan",
  ): Promise<unknown[]> {
    const result = await db.execute(sql`
      SELECT p.id, bo.offer_id, bo.current_price, bo.in_stock, bo.merchant_id, bo.trust_score
      FROM product p
      ${bestOfferJoin(sql`p.id`, scope, mode, strategy)}
      WHERE p.id = ANY(${`{${productIds.join(",")}}`}::bigint[])
      ORDER BY p.id
    `);
    return result.rows;
  }

  const scopes: [string, () => BestOfferScope][] = [
    ["kapsam yok", () => ({})],
    ["yalniz stokta", () => ({ inStockOnly: true })],
    ["magaza b", () => ({ merchantIds: [merchants.b as number] })],
  ];

  for (const [name, scope] of scopes) {
    for (const mode of ["inner", "left"] as const) {
      it(`${name}, ${mode}`, async () => {
        const lateral = await pick(scope(), mode, "lateral");
        const scan = await pick(scope(), mode, "scan");
        expect(lateral).toEqual(scan);
        expect(lateral.length).toBeGreaterThan(0);
      });
    }
  }

  it("kural: pasif magaza/USD/pasif teklif sayilmaz, fiyatsiz en sona", async () => {
    const rows = (await pick({}, "left", "lateral")) as { current_price: string | null }[];
    const prices = rows.map((row) =>
      row.current_price === null ? null : Number(row.current_price),
    );
    expect(prices).toEqual([300, 700, 200, 800, null, null, null]);
    const inner = await pick({}, "inner", "lateral");
    expect(inner).toHaveLength(5);
  });

  it("yol secimi: daraltan bir sey yoksa scan, varsa lateral", () => {
    expect(bestOfferStrategy({}, 0)).toBe("scan");
    expect(bestOfferStrategy({ price_max: 100_000, in_stock_only: true }, 0)).toBe("scan");
    expect(bestOfferStrategy({ merchant_ids: [1] }, 0)).toBe("scan");
    expect(bestOfferStrategy({}, 1)).toBe("lateral");
    expect(bestOfferStrategy({ category_path: "moda" }, 0)).toBe("lateral");
    expect(bestOfferStrategy({ color: ["red"] }, 0)).toBe("lateral");
    expect(bestOfferStrategy({ brand_include: ["nike"] }, 0)).toBe("lateral");
    expect(bestOfferStrategy({ size_norm: "42" }, 0)).toBe("lateral");
    expect(bestOfferStrategy({ color: [] }, 0)).toBe("scan");
  });
});
