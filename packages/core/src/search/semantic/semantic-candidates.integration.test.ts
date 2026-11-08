/**
 * Anlamsal aday kesfi ve gölge olcum kaydi (karar 0178): gercek PostgreSQL + pgvector halfvec.
 * Dogrulananlar: en yakin komsu siralamasi, metin aramasinin suzgeclerinin (fiyat) adaya da
 * uygulanmasi, yayinda olmayan urunun elenmesi, metin sonucu benzerlikleri, olcum satirinin
 * yalniz sayisal alanlarla yazilmasi.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshProductAggregates } from "../../product/refresh-aggregates.ts";
import { getTestDb, withOwnerClient } from "../../test-db.ts";
import type { QueryEmbedder } from "./query-embedder.ts";
import { findSemanticCandidates, similaritiesFor } from "./semantic-candidates.ts";
import { measureSemanticShadow } from "./shadow.ts";

const MODEL = "test-semantic-shadow-model";

function axis(index: number, tilt = 0): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[index] = 1;
  if (tilt > 0) vector[index + 1] = tilt;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

describe("anlamsal adaylar (product_text_embedding)", () => {
  const suffix = `sem-${Date.now()}`;
  let db: Database;
  let merchant = 0;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
         VALUES ($1, $2, $3, 'xml_feed', TRUE, 80) RETURNING id`,
        [`m-${suffix}`, `Anlamsal ${suffix}`, `${suffix}.example.test`],
      );
      merchant = Number(m.rows[0].id);
      const make = async (key: string, price: number, vector: number[], state = "published") => {
        const p = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`${key}-${suffix}`, `Gadget ${key} ${suffix}`],
        );
        const id = Number(p.rows[0].id);
        ids[key] = id;
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, currency, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $3, $5, 'TRY', TRUE, TRUE)`,
          [merchant, id, `${key}-${suffix}`, `https://${suffix}.example.test/${key}`, price],
        );
        await client.query(
          `INSERT INTO product_text_embedding
             (product_id, model_version, text_version, content_hash, source_hash, embedding)
           VALUES ($1, $2, 1, decode(md5($3), 'hex'), decode(md5($3), 'hex'), $4::halfvec(768))`,
          [id, MODEL, key, `[${vector.join(",")}]`],
        );
        if (state !== "published") {
          await client.query(
            `UPDATE product SET publication_state = $2, source_merchant_id = $3,
                                source_external_id = $4 WHERE id = $1`,
            [id, state, merchant, `src-${key}-${suffix}`],
          );
        }
      };
      await make("near", 100_000, axis(40));
      await make("mid", 120_000, axis(40, 0.6));
      await make("far", 90_000, axis(300));
      await make("pricey", 900_000, axis(40, 0.1));
      await make("draft", 100_000, axis(40, 0.05), "draft");
    });
    await refreshProductAggregates(db, { productIds: Object.values(ids) });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchant]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`%-${suffix}`]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchant]);
      await client.query("DELETE FROM semantic_shadow_event WHERE model_version = $1", [MODEL]);
    });
  });

  it("en yakin komsu sirasi, fiyat suzgeci ve yayin durumu", async () => {
    const all = await findSemanticCandidates(db, {
      vector: axis(40),
      modelVersion: MODEL,
      text: "gadget",
      filters: {},
    });
    const order = all.map((c) => c.productId);
    expect(order.slice(0, 3)).toEqual([ids.near, ids.pricey, ids.mid]);
    expect(order).not.toContain(ids.draft);
    expect(all[0]?.similarity).toBeCloseTo(1, 2);

    const cheap = await findSemanticCandidates(db, {
      vector: axis(40),
      modelVersion: MODEL,
      text: "gadget",
      filters: { price_max: 200_000 },
    });
    expect(cheap.map((c) => c.productId)).not.toContain(ids.pricey);
    expect(cheap.map((c) => c.productId)).toContain(ids.near);
  });

  it("gecersiz model adi SQL'e girmez", async () => {
    await expect(
      findSemanticCandidates(db, {
        vector: axis(40),
        modelVersion: "bad'model",
        text: "x",
        filters: {},
      }),
    ).rejects.toThrow("model_version");
  });

  it("metin sonucu benzerlikleri yalniz vektoru olanlar icin doner", async () => {
    const map = await similaritiesFor(db, {
      vector: axis(300),
      modelVersion: MODEL,
      productIds: [ids.far as number, ids.near as number, 987_654_321],
    });
    expect(map.get(ids.far as number)).toBeCloseTo(1, 2);
    expect(map.get(ids.near as number)).toBeCloseTo(0, 2);
    expect(map.has(987_654_321)).toBe(false);
  });

  it("olcum satiri yalniz sayisal alanlarla yazilir", async () => {
    const embedder: QueryEmbedder = {
      modelVersion: MODEL,
      embedQuery: async () => ({ vector: axis(40), cacheHit: true, latencyMs: 1 }),
    };
    const metrics = await measureSemanticShadow(
      db,
      {
        semanticText: "gadget",
        queryText: "gadget",
        filters: {},
        textItems: [{ productId: ids.far as number, title: `Gadget far ${suffix}` }],
        topN: 6,
      },
      {
        env: { SEMANTIC_SEARCH_MODE: "shadow", SEMANTIC_EMBEDDING_MODEL: MODEL },
        embedder,
        usedToday: async () => 0,
        random: () => 0,
      },
    );
    expect(metrics).toMatchObject({ outcome: "measured", textWithVector: 1 });
    // Kapi: near (1,0) ve pricey (0,995) gecer; mid (0,857) en iyiden 0,12'den fazla geride.
    expect(metrics).toMatchObject({ gatePassed: 2, semanticOnly: 2, newInTopN: 2 });

    await withOwnerClient(async (client) => {
      const rows = await client.query(
        `SELECT outcome, top_n, text_count, text_with_vector, semantic_only, new_in_top_n, cache_hit
           FROM semantic_shadow_event WHERE model_version = $1`,
        [MODEL],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        outcome: "measured",
        top_n: 6,
        text_count: 1,
        text_with_vector: 1,
        cache_hit: true,
      });
      const columns = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'semantic_shadow_event'`,
      );
      const names = columns.rows.map((r: { column_name: string }) => r.column_name);
      expect(names.some((n: string) => /query|text$|session|user|product/.test(n))).toBe(false);
    });
  });
});
