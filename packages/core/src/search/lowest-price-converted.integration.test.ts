/**
 * `lowest_price` yurt dışı (kurla çevrilmiş) fiyatlarda da gerçekten fiyata göre sıralar. Katalogun
 * ~%99,96'sı AliExpress (USD) olduğundan, yalnız TRY teklifleri sıralayan eski kural sekmeyi
 * alaka sıralamasına düşürüyordu. Kart fiyatı (`current_price`) zaten TCMB kuruyla çevrilmiş tutardır;
 * sıralama kartta gösterilen sayıyla aynı olmalıdır. Kuru olmayan ya da sıfır fiyat BELİRSİZDİR:
 * en ucuz sayılmaz, sona gider.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { search } from "./search.ts";
import type { QueryObject } from "./types.ts";

const tag = `zxqcnv${Date.now().toString(36).replace(/[0-9]/g, "k")}`;
// Başka testlerle çakışmaması için nadir para birimleri: KWD kurlu, OMR kursuz.
const RATE_CCY = "KWD";
const NO_RATE_CCY = "OMR";
const RATE = 100; // 1 KWD = 100 TL

function query(sort: QueryObject["sort"]): QueryObject {
  const text = `${tag} masa lambasi`;
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

interface Fixture {
  name: string;
  price: number; // teklif para biriminin alt birimi
  currency: string;
  inStock?: boolean;
}

describe("lowest_price: converted foreign prices", () => {
  let db: Database;
  const ids = new Map<string, number>();
  let merchantId = 0;
  let rateId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const rate = await client.query(
        `INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date)
         VALUES ('tcmb', $1, 'TRY', $2, 'forex_selling', (now() AT TIME ZONE 'UTC')::date)
         ON CONFLICT (source, base, quote, rate_kind, effective_date) DO UPDATE SET rate = EXCLUDED.rate
         RETURNING id`,
        [RATE_CCY, RATE],
      );
      rateId = Number(rate.rows[0].id);
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
         VALUES ($1, 'Kurlu Siralama', $2, 'xml_feed', 80) RETURNING id`,
        [`cnv-${tag}`, `cnv-${tag}.example.test`],
      );
      merchantId = Number(m.rows[0].id);
      const fixtures: Fixture[] = [
        { name: "tryUc", price: 30_000, currency: "TRY" }, // 300 TL
        { name: "kurIki", price: 250, currency: RATE_CCY }, // 2,50 KWD -> 250 TL (yaklaşık)
        { name: "kurBir", price: 100, currency: RATE_CCY }, // 1,00 KWD -> 100 TL (yaklaşık)
        { name: "kursuz", price: 50, currency: NO_RATE_CCY }, // kur yok: fiyat BELİRSİZ
        { name: "sifir", price: 0, currency: "TRY" }, // sıfır fiyat: BELİRSİZ
        { name: "stoksuz", price: 10, currency: RATE_CCY, inStock: false }, // 10 TL ama stokta yok
      ];
      for (const [i, f] of fixtures.entries()) {
        const key = `${tag}-${i}`;
        const p = await client.query(
          `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           VALUES ($1, $2, NULL, NULL, 1, $3) RETURNING id`,
          [key, `${tag} masa lambasi ${f.name}`, f.inStock === false ? 0 : 1],
        );
        const id = Number(p.rows[0].id);
        ids.set(f.name, id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, currency, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
          [
            merchantId,
            id,
            key,
            `https://cnv-${tag}.example.test/${key}`,
            `${tag} masa lambasi ${f.name}`,
            f.price,
            f.currency,
            f.inStock !== false,
          ],
        );
      }
    });
  });

  afterAll(async () => {
    const all = [...ids.values()];
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE product_id = ANY($1)", [all]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [all]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM fx_rate WHERE id = $1", [rateId]);
    });
  });

  const names = async (sort: QueryObject["sort"]) => {
    const result = await search(db, query(sort), { limit: 30 });
    const byId = new Map([...ids].map(([name, id]) => [id, name]));
    return result.items.map((item) => ({
      name: byId.get(item.productId) as string,
      price: item.minPrice,
    }));
  };

  it("orders TRY and converted foreign offers by the price the card shows", async () => {
    const got = await names("lowest_price");
    const known = got.filter((x) => ["kurBir", "kurIki", "tryUc"].includes(x.name));
    expect(known.map((x) => x.name)).toEqual(["kurBir", "kurIki", "tryUc"]);
    // kartta gösterilen fiyatlar (kuruş) artan
    expect(known.map((x) => x.price)).toEqual([10_000, 25_000, 30_000]);
  });

  it("never ranks an unknown price (no FX rate, zero price) as cheapest", async () => {
    const got = (await names("lowest_price")).map((x) => x.name);
    const lastKnown = Math.max(...["kurBir", "kurIki", "tryUc"].map((n) => got.indexOf(n)));
    for (const unknown of ["kursuz", "sifir"]) {
      expect(got, unknown).toContain(unknown);
      expect(got.indexOf(unknown), unknown).toBeGreaterThan(lastKnown);
    }
  });

  it("keeps in-stock offers ahead of a cheaper out-of-stock one", async () => {
    const got = (await names("lowest_price")).map((x) => x.name);
    expect(got.indexOf("stoksuz")).toBeGreaterThan(got.indexOf("tryUc"));
  });

  it("does not change the other sorts: balanced and best_match are not price-ordered", async () => {
    const balanced = (await names("balanced")).map((x) => x.name);
    const match = (await names("best_match")).map((x) => x.name);
    // Aynı aday kümesi, her sıralama hepsini döndürür.
    expect([...balanced].sort()).toEqual([...match].sort());
    expect(balanced).toHaveLength(6);
  });
});
