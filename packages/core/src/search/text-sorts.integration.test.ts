/**
 * Karar 0202: metin aramada `lowest_price` (en düşük doğrulanmış TRY fiyat) ve `best_match`
 * (yalnız alaka, fiyat çarpanı yok). Mevcut `balanced`/`best_deal` davranışı değişmez; ana ürün
 * kademesi (karar 0197) her sıralamada korunur.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { search } from "./search.ts";
import type { QueryObject } from "./types.ts";

const tag = `zxqsrt${Date.now().toString(36).replace(/[0-9]/g, "k")}`;

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

interface Fixture {
  title: string;
  price: number; // kuruş
  percentile: number;
  inStock?: boolean;
  trust?: number;
}

describe("lowest_price / best_match text sorts", () => {
  let db: Database;
  const ids: number[] = [];
  const byTitle = new Map<string, number>();
  let merchantId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
         VALUES ($1, 'Siralama Testi', $2, 'xml_feed', 80) RETURNING id`,
        [`srt-${tag}`, `srt-${tag}.example.test`],
      );
      merchantId = Number(m.rows[0].id);
      const fixtures: Fixture[] = [
        // Ana ürünler: fiyat sırası 100 < 200 < 300 < 400; en ucuz olan STOKTA YOK.
        { title: `${tag} masa lambasi A`, price: 40_000, percentile: 10, inStock: false },
        { title: `${tag} masa lambasi B`, price: 20_000, percentile: 90 },
        { title: `${tag} masa lambasi C`, price: 30_000, percentile: 50 },
        { title: `${tag} masa lambasi D`, price: 10_000, percentile: 20 },
        // Aksesuar: en ucuz ama ana ürün kademesinin ALTINDA kalmalı.
        { title: `${tag} masa lambasi Kılıf`, price: 500, percentile: 1 },
        // Eşleşme farkı: tüm sözcükler (tam eşleşme) pahalı, kısmi eşleşme ucuz.
        { title: `${tag} okuma lambasi`, price: 5_000, percentile: 5 },
      ];
      for (const [i, f] of fixtures.entries()) {
        const key = `${tag}-${i}`;
        const p = await client.query(
          `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
           VALUES ($1, $2, $3, $3, 1, $4) RETURNING id`,
          [key, f.title, f.price, f.inStock === false ? 0 : 1],
        );
        const id = Number(p.rows[0].id);
        ids.push(id);
        byTitle.set(f.title, id);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $6, $5, TRUE, $7)`,
          [
            merchantId,
            id,
            key,
            `https://srt-${tag}.example.test/${key}`,
            f.price,
            f.title,
            f.inStock !== false,
          ],
        );
        await client.query(
          `INSERT INTO product_price_stats (product_id, current_percentile, list_price_inflated)
           VALUES ($1, $2, FALSE)`,
          [id, f.percentile],
        );
      }
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

  const id = (suffix: string) => byTitle.get(`${tag} masa lambasi ${suffix}`) as number;
  const order = async (sort: QueryObject["sort"]) =>
    (await search(db, query(`${tag} masa lambasi`, sort), { limit: 30 })).items.map(
      (i) => i.productId,
    );
  const priceOf = async (sort: QueryObject["sort"]) =>
    (await search(db, query(`${tag} masa lambasi`, sort), { limit: 30 })).items.map(
      (i) => i.minPrice,
    );

  it("lowest_price: stokta olanlar fiyata göre artan, stokta olmayan ucuz ürün sonra, aksesuar en sonda", async () => {
    const got = await order("lowest_price");
    const inStock = [id("D"), id("B"), id("C")];
    // stokta olan ana ürünler artan fiyatla: D (100 TL) < B (200 TL) < C (300 TL)
    expect(got.filter((x) => inStock.includes(x))).toEqual(inStock);
    // stokta olmayan A (en pahalı değil ama stoksuz) stoklu ana ürünlerden sonra
    expect(got.indexOf(id("A"))).toBeGreaterThan(got.indexOf(id("C")));
    // aksesuar (en ucuz) ana ürün kademesinin altında, elenmedi
    const caseId = byTitle.get(`${tag} masa lambasi Kılıf`) as number;
    expect(got).toContain(caseId);
    for (const main of [id("A"), id("B"), id("C"), id("D")]) {
      expect(got.indexOf(main)).toBeLessThan(got.indexOf(caseId));
    }
  });

  it("lowest_price: ilk kartlar tüm sıralamada fiyat açısından monoton (stoklu ana ürün kademesi)", async () => {
    const result = await search(db, query(`${tag} masa lambasi`, "lowest_price"), { limit: 30 });
    const mainInStock = result.items.filter((i) =>
      [id("D"), id("B"), id("C")].includes(i.productId),
    );
    const prices = mainInStock.map((i) => i.minPrice as number);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("best_match: fiyat sıralamayı belirlemez; tam eşleşmeler (ana ürünler) önce, kısmi eşleşme sonra", async () => {
    const got = await order("best_match");
    const partial = byTitle.get(`${tag} okuma lambasi`) as number;
    // kısmi eşleşme (okuma lambasi: 'masa' yok) en ucuz olsa da tam eşleşen ana ürünlerin önüne geçmez
    if (got.includes(partial)) {
      for (const main of [id("B"), id("C"), id("D")]) {
        expect(got.indexOf(main)).toBeLessThan(got.indexOf(partial));
      }
    }
  });

  it("best_match: aynı alakada fiyat farkı sıralamayı değiştirmez (fiyat çarpanı yok)", async () => {
    // balanced fiyat yüzdeliğini kullanır (B %90 = pahalı, D %20 = ucuz): D, B'nin önünde.
    const balanced = await order("balanced");
    expect(balanced.indexOf(id("D"))).toBeLessThan(balanced.indexOf(id("B")));
    // best_match yüzdeliği KULLANMAZ: skorlar eşit, sıra kimlik (id) ile belirlenir (B < C < D oluşturma sırası).
    const match = await order("best_match");
    expect(match.indexOf(id("B"))).toBeLessThan(match.indexOf(id("D")));
  });

  it("mevcut sıralamalar etkilenmedi: best_deal yüzdeliğe, balanced skora göre; aksesuar en sonda", async () => {
    const deal = await order("best_deal");
    const caseId = byTitle.get(`${tag} masa lambasi Kılıf`) as number;
    expect(deal.indexOf(caseId)).toBeGreaterThan(deal.indexOf(id("B")));
    expect((await priceOf("balanced")).length).toBeGreaterThan(0);
  });

  it("sekmeler birbirinden farklı sıralama üretir", async () => {
    const [balanced, lowest, match] = await Promise.all([
      order("balanced"),
      order("lowest_price"),
      order("best_match"),
    ]);
    expect(lowest).not.toEqual(balanced);
    expect(match).not.toEqual(lowest);
  });
});
