/**
 * Karar 0129: sinirli aday kumesi. Yaygin bir bas isim aday dalini doldurdugunda
 * (bolum basina `CANDIDATE_LIMIT`) arama yine dogru urunleri bulur:
 *
 * - yuzlerce yurt disi ilan, ayni kelimeyi tasiyan TRY teklifli urunleri itmez
 *   (TRY ve teklifsiz/yurt disi bolumleri ayri sinirlanir);
 * - tum niteleyicileri tasiyan urun siki dal sayesinde aday kalir;
 * - urun kolonu filtresi (marka) aday dalina itilir: sinir dolsa da markali urun bulunur;
 * - "en iyi firsatlar" yalnizca TRY bolumunden aday alir;
 * - toplam alt sinir oldugunda `totalCapped` doner.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshProductAggregates } from "../product/refresh-aggregates.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { search } from "./search.ts";
import { CANDIDATE_LIMIT } from "./text-match.ts";
import type { QueryObject } from "./types.ts";

/** Testte uydurulmus bas isim: baska urunle eslesmez. */
const HEAD = "kvarnokilif";
const QUALIFIER = "zemprolux";
const FLOOD = CANDIDATE_LIMIT + 150;

function textQuery(slots: string[][], overrides: Partial<QueryObject> = {}): QueryObject {
  const text = slots.map((slot) => slot[0]).join(" ");
  return {
    intent: "browse",
    anchor: null,
    text,
    filters: {},
    style_tags: [],
    sort: "balanced",
    unparsed: text,
    confidence: 1,
    text_slots: slots,
    ...overrides,
  };
}

describe("sinirli aday kumesi (karar 0129)", () => {
  const suffix = `cand-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  let db: Database;
  let trMerchant = 0;
  let foreignMerchant = 0;
  let brandId = 0;
  const tryIds: number[] = [];
  let strictId = 0;
  let brandedId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string): Promise<number> => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $2, $3, 'xml_feed', TRUE, 70) RETURNING id`,
          [`${key}-${suffix}`, `Aday Testi ${key}`, `${key}-${suffix}.example.test`],
        );
        return Number(row.rows[0].id);
      };
      trMerchant = await merchant("tr");
      foreignMerchant = await merchant("yd");
      const brand = await client.query(
        "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
        [`marka-${suffix}`, `Markatest ${suffix}`, `markatest-${suffix}`],
      );
      brandId = Number(brand.rows[0].id);

      await client.query(
        `INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
         VALUES ('tcmb', 'USD', 'TRY', 41.5, 'forex_selling', $1, $2)
         ON CONFLICT DO NOTHING`,
        [today, suffix],
      );

      // Once yurt disi sel (dusuk kimlik = fiziksel olarak once), sonra TRY urunleri.
      await client.query(
        `WITH p AS (
           INSERT INTO product (slug, title)
           SELECT 'yd-' || g || '-' || $1, 'Luxury ' || $2 || ' Magnetic Cover ' || g
           FROM generate_series(1, $3::int) g
           RETURNING id, slug
         )
         INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                            current_price, currency, is_active, in_stock)
         SELECT $4, p.id, p.slug, 'https://yd.example.test/' || p.slug, p.slug, 500, 'USD', TRUE, TRUE
         FROM p`,
        [suffix, HEAD, FLOOD, foreignMerchant],
      );
      const tryProduct = async (key: string, title: string, brand: number | null) => {
        const row = await client.query(
          "INSERT INTO product (slug, title, brand_id) VALUES ($1, $2, $3) RETURNING id",
          [`${key}-${suffix}`, title, brand],
        );
        const id = Number(row.rows[0].id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, currency, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $3, 25000, 'TRY', TRUE, TRUE)`,
          [trMerchant, id, `${key}-${suffix}`, `https://tr.example.test/${key}-${suffix}`],
        );
        await client.query(
          `INSERT INTO product_price_stats (product_id, current_percentile, list_price_inflated)
           VALUES ($1, 10, FALSE)`,
          [id],
        );
        return id;
      };
      for (let i = 0; i < 3; i += 1) {
        tryIds.push(await tryProduct(`tr${i}`, `Silikon Telefon ${HEAD} ${i}`, null));
      }
      brandedId = await tryProduct("marka", `Darbe Emici ${HEAD}`, brandId);
      // Siki dal: TRY degil, yurt disi selin SONUNDA; bas isim dali onu kapsamaz.
      const strict = await client.query(
        `INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id`,
        [`siki-${suffix}`, `${QUALIFIER} Pro ${HEAD}`],
      );
      strictId = Number(strict.rows[0].id);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                            current_price, currency, is_active, in_stock)
         VALUES ($1, $2, $3, $4, $3, 700, 'USD', TRUE, TRUE)`,
        [foreignMerchant, strictId, `siki-${suffix}`, `https://yd.example.test/siki-${suffix}`],
      );
    });
    const ids = await withOwnerClient(async (client) =>
      client.query("SELECT id FROM product WHERE slug LIKE $1", [`%-${suffix}`]),
    );
    await refreshProductAggregates(db, { productIds: ids.rows.map((row) => Number(row.id)) });
  }, 120_000);

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM product_price_stats WHERE product_id IN (SELECT id FROM product WHERE slug LIKE $1)",
        [`%-${suffix}`],
      );
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [
        [trMerchant, foreignMerchant],
      ]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`%-${suffix}`]);
      await client.query("DELETE FROM brand WHERE id = $1", [brandId]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [
        [trMerchant, foreignMerchant],
      ]);
      await client.query("DELETE FROM fx_rate WHERE bulletin = $1", [suffix]);
    });
  });

  it("yurt disi sel TRY teklifli urunleri adaydan itmez; toplam alt sinirdir", async () => {
    const result = await search(db, textQuery([[HEAD]]), { limit: 24 });
    const ids = result.items.map((item) => item.productId);
    for (const id of tryIds) expect(ids).toContain(id);
    // Esit alakada TRY once (yurt disi guven carpani).
    expect(ids.slice(0, tryIds.length + 1)).toEqual(expect.arrayContaining(tryIds));
    expect(result.totalCapped).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(CANDIDATE_LIMIT);
  });

  it("tum niteleyicileri tasiyan urun bas isim dali doldugunda da bulunur", async () => {
    const result = await search(db, textQuery([[QUALIFIER], [HEAD]]), { limit: 24 });
    expect(result.items.map((item) => item.productId)).toEqual([strictId]);
    expect(result.totalCapped).not.toBe(true);
    expect(result.total).toBe(1);
  });

  it("marka filtresi aday dalina itilir", async () => {
    const result = await search(
      db,
      textQuery([[HEAD]], { filters: { brand_include: [`markatest-${suffix}`] } }),
      { limit: 24 },
    );
    expect(result.items.map((item) => item.productId)).toEqual([brandedId]);
    expect(result.total).toBe(1);
  });

  it("en iyi firsatlar yalnizca TRY bolumunden aday alir", async () => {
    const result = await search(db, textQuery([[HEAD]], { sort: "best_deal" }), { limit: 24 });
    const ids = result.items.map((item) => item.productId).sort((a, b) => a - b);
    expect(ids).toEqual([...tryIds, brandedId].sort((a, b) => a - b));
    expect(result.items.every((item) => item.foreignPrice === undefined)).toBe(true);
  });

  it("sinir dolmadiginda toplam kesindir", async () => {
    const result = await search(db, textQuery([["silikon"], [HEAD]]), { limit: 24 });
    expect(result.items.map((item) => item.productId).sort((a, b) => a - b)).toEqual(
      [...tryIds].sort((a, b) => a - b),
    );
    expect(result.total).toBe(tryIds.length);
    expect(result.totalCapped).not.toBe(true);
  });
});
