/**
 * Karar 0124: yalnizca yurt disi (TRY disi) teklifi olan yayinlanmis urun arama
 * yuzeylerinde gorunur; fiyati TCMB kuruyla YAKLASIK kurustur ve orijinal tutar
 * `foreignPrice` ile tasinir. Kur yoksa gorunmez (kur uydurulmaz). Esit alakada
 * TRY teklifli urun onde; "en iyi fiyat" sekmesine yurt disi girmez. Fiyat ozeti
 * (`min_price`, `offer_count`) TRY-only kalir, `foreign_offer_count` sayilir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshProductAggregates } from "../product/refresh-aggregates.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { findAlternatives } from "./find-alternatives.ts";
import { search } from "./search.ts";
import type { QueryObject } from "./types.ts";
import { searchByImageVector } from "./visual-search.ts";

const MODEL = "test-foreign-offer-model";
/** Testte uydurulmus, yalnizca bu dosyanin kelimesi: baska urunle eslesmez. */
const WORD = "zorblatkulak";

function axis(index: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[index] = 1;
  return vector;
}

function textQuery(sort: QueryObject["sort"]): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: WORD,
    filters: {},
    style_tags: [],
    sort,
    unparsed: WORD,
    confidence: 1,
  };
}

describe("yurt disi teklifli urun aramada (karar 0124)", () => {
  const suffix = `fx-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  let db: Database;
  let trMerchant = 0;
  let foreignMerchant = 0;
  let foreignOnly = 0;
  let tryTwin = 0;
  let noRate = 0;
  let anchor = 0;
  let usdRate = "0";
  const offerIds: number[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (key: string, trust: number): Promise<number> => {
        const row = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
           VALUES ($1, $2, $3, 'xml_feed', TRUE, $4) RETURNING id`,
          [`${key}-${suffix}`, `Yurt Disi Testi ${key}`, `${key}-${suffix}.example.test`, trust],
        );
        return Number(row.rows[0].id);
      };
      trMerchant = await merchant("tr", 80);
      foreignMerchant = await merchant("yd", 80);

      const product = async (key: string): Promise<number> => {
        const row = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`${key}-${suffix}`, `${WORD} kablosuz ${key} ${suffix}`],
        );
        return Number(row.rows[0].id);
      };
      foreignOnly = await product("yurtdisi");
      tryTwin = await product("yerli");
      noRate = await product("kursuz");
      anchor = await product("capa");

      const offer = async (
        merchantId: number,
        productId: number,
        key: string,
        price: number,
        currency: string,
      ): Promise<number> => {
        const row = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, currency, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $3, $5, $6, TRUE, TRUE) RETURNING id`,
          [
            merchantId,
            productId,
            `${key}-${suffix}`,
            `https://${key}-${suffix}.example.test/u`,
            price,
            currency,
          ],
        );
        const id = Number(row.rows[0].id);
        offerIds.push(id);
        return id;
      };
      const foreignOffer = await offer(foreignMerchant, foreignOnly, "usd", 3_000, "USD");
      await offer(trMerchant, tryTwin, "try", 150_000, "TRY");
      await offer(foreignMerchant, noRate, "xyz", 3_000, "XYZ");
      await offer(trMerchant, anchor, "capa", 200_000, "TRY");

      await client.query(
        `INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
         VALUES ('tcmb', 'USD', 'TRY', 41.5, 'forex_selling', $1, $2)
         ON CONFLICT DO NOTHING`,
        [today, suffix],
      );
      const rate = await client.query(
        `SELECT rate::text FROM fx_rate
          WHERE source = 'tcmb' AND base = 'USD' AND quote = 'TRY'
            AND rate_kind = 'forex_selling' AND effective_date = $1`,
        [today],
      );
      usdRate = String(rate.rows[0].rate);

      await client.query(
        `INSERT INTO similarity_edge (product_a, product_b, kind, score)
         VALUES ($1, $2, 'visual', 0.9)`,
        [anchor, foreignOnly],
      );
      await client.query(
        `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
         VALUES ('offer', $1, 'image', $2, $3::vector)`,
        [foreignOffer, MODEL, `[${axis(17).join(",")}]`],
      );
    });
    await refreshProductAggregates(db, { productIds: [foreignOnly, tryTwin, noRate, anchor] });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM embedding WHERE target_type = 'offer' AND target_id = ANY($1)",
        [offerIds],
      );
      await client.query("DELETE FROM similarity_edge WHERE product_a = $1", [anchor]);
      await client.query("DELETE FROM offer WHERE id = ANY($1)", [offerIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [
        [foreignOnly, tryTwin, noRate, anchor],
      ]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [
        [trMerchant, foreignMerchant],
      ]);
      await client.query("DELETE FROM fx_rate WHERE bulletin = $1", [suffix]);
    });
  });

  /** 30,00 USD * kur, yarim yukari (numeric; float yok). */
  function expectedKurus(): number {
    const [whole = "0", fraction = ""] = usdRate.split(".");
    const scaled = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0").slice(0, 8));
    return Number((3_000n * scaled + 50_000_000n) / 100_000_000n);
  }

  it("fiyat ozeti TRY-only kalir; yurt disi teklif ayrica sayilir", async () => {
    const rows = await withOwnerClient(async (client) =>
      client.query(
        `SELECT id, min_price, offer_count, foreign_offer_count FROM product
          WHERE id = ANY($1) ORDER BY id`,
        [[foreignOnly, tryTwin]],
      ),
    );
    const byId = new Map(rows.rows.map((row) => [Number(row.id), row]));
    expect(byId.get(foreignOnly)).toMatchObject({
      min_price: null,
      offer_count: 0,
      foreign_offer_count: 1,
    });
    expect(byId.get(tryTwin)).toMatchObject({ offer_count: 1, foreign_offer_count: 0 });
  });

  it("metin aramasinda yaklasik TL ile gorunur, TRY esdegeri onde, kursuz gorunmez", async () => {
    const result = await search(db, textQuery("balanced"));
    const ids = result.items.map((item) => item.productId);
    expect(ids).toContain(foreignOnly);
    expect(ids).toContain(tryTwin);
    expect(ids).not.toContain(noRate);
    expect(ids.indexOf(tryTwin)).toBeLessThan(ids.indexOf(foreignOnly));

    const foreign = result.items.find((item) => item.productId === foreignOnly);
    expect(foreign?.minPrice).toBe(expectedKurus());
    expect(foreign?.foreignPrice).toEqual({ originalMinor: 3_000, currency: "USD", fxDate: today });
    const domestic = result.items.find((item) => item.productId === tryTwin);
    expect(domestic?.minPrice).toBe(150_000);
    expect(domestic?.foreignPrice).toBeUndefined();
  });

  it("yaklasik TL fiyat suzgecine girer", async () => {
    const result = await search(db, {
      ...textQuery("balanced"),
      filters: { price_max: expectedKurus() - 1 },
    });
    expect(result.items.map((item) => item.productId)).not.toContain(foreignOnly);
  });

  it("en iyi fiyat sekmesine yurt disi teklif girmez", async () => {
    const result = await search(db, textQuery("best_deal"));
    expect(result.items.map((item) => item.productId)).not.toContain(foreignOnly);
  });

  it("alternatifler ve gorsel arama ayni yaklasik fiyati tasir", async () => {
    const alternatives = await findAlternatives(db, anchor);
    const alt = alternatives.find((item) => item.productId === foreignOnly);
    expect(alt?.minPrice).toBe(expectedKurus());
    expect(alt?.foreignPrice?.currency).toBe("USD");

    const visual = await searchByImageVector(db, axis(17), MODEL, { limit: 5 });
    const hit = visual.find((item) => item.productId === foreignOnly);
    expect(hit?.minPrice).toBe(expectedKurus());
    expect(hit?.foreignPrice?.originalMinor).toBe(3_000);
  });
});
