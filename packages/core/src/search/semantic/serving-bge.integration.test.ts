/**
 * BGE-M3 (1024 boyut, `product_text_embedding_d1024`) sunumu, gercek PostgreSQL + pgvector (karar 0196).
 *
 * Dogrulananlar:
 * - EXPLAIN: kismi HNSW (`halfvec_cosine_ops`, `model_version` kosullu) d1024 tablosunda global KNN'de
 *   kullanilabilir; envanter indeksi `ready` + dogru model/surum okur; secici `global_hnsw` secer.
 * - Model karismaz: ayni tabloda baska `model_version`'a ait en yakin vektor ASLA adaylara girmez.
 * - Kesin kategori ve fiyat suzgeci anlamsal eklemeyi de baglar (SQL + kart yukleme).
 * - Uctan uca sunum (sahte embedder, gercek SQL, gercek lexical arama): metin sonuclari korunur,
 *   yalniz-anlamsal urun eklenir; embedder yoksa/vektor vermezse sonuc BIREBIR ayni.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshProductAggregates } from "../../product/refresh-aggregates.ts";
import { getTestDb, withOwnerClient } from "../../test-db.ts";
import { createSeedAliasSource } from "../fallback/aliases.ts";
import { searchWithFallback } from "../fallback/pipeline.ts";
import { createPostgresSearchProvider } from "../fallback/postgres-provider.ts";
import type { RankedSearchItem } from "../fallback/types.ts";
import type { QueryObject } from "../types.ts";
import type { SemanticIndex } from "./active-index.ts";
import { loadSemanticInventory, resetInventoryCache } from "./inventory.ts";
import { createProviderHealth } from "./provider-health.ts";
import {
  findCategoryExactCandidates,
  findSemanticCandidates,
  globalKnnSql,
} from "./semantic-candidates.ts";
import { applySemanticServing } from "./serving.ts";
import { selectSemanticStrategy } from "./strategy.ts";

const suffix = `b${Date.now()}`;
/** Uretim modeli degil: paylasilan test veritabanini bozmamak icin benzersiz model adi. */
const MODEL = `bge-test-${suffix}`;
const OTHER_MODEL = `bge-other-${suffix}`;
const ROOT = `zb${suffix}`;
const SHOES = `${ROOT}/ayakkabi`;
const BAGS = `${ROOT}/canta`;
const HNSW_NAME = `pte1024_hnsw_${MODEL.replaceAll("-", "_")}_v1`;
const INDEX: SemanticIndex = {
  modelVersion: MODEL,
  table: "product_text_embedding_d1024",
  dimensions: 1024,
  queryTask: "query",
  provider: "remote_http",
  fusion: "conditional_hybrid",
};

function axis(index: number, tilt = 0): number[] {
  const vector = new Array<number>(1024).fill(0);
  vector[index] = 1;
  if (tilt > 0) vector[index + 1] = tilt;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}
const literal = (v: number[]) => `[${v.join(",")}]`;

function parsed(text: string, filters: QueryObject["filters"]): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text,
    filters,
    style_tags: [],
    sort: "balanced",
    unparsed: text,
    confidence: 1,
  };
}

describe("BGE-M3 d1024 sunumu (gercek PG)", () => {
  let db: Database;
  let merchant = 0;
  const ids = {} as Record<"run" | "walk" | "bag" | "pricey" | "semonly" | "foreign", number>;

  beforeAll(async () => {
    db = getTestDb();
    resetInventoryCache();
    await withOwnerClient(async (client) => {
      for (const [key, path] of Object.entries({ ROOT, SHOES, BAGS })) {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        await client.query(
          `INSERT INTO category (slug, name, path, parent_id)
           VALUES ($1, $2, $3, (SELECT id FROM category WHERE path = $4))`,
          [path.replaceAll("/", "-"), key, path, parent],
        );
      }
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
         VALUES ($1, $2, $3, 'xml_feed', TRUE, 80) RETURNING id`,
        [`mb-${suffix}`, `BGE ${suffix}`, `${suffix}.example.test`],
      );
      merchant = Number(m.rows[0].id);
      const make = async (
        key: string,
        title: string,
        category: string,
        price: number,
        vector: number[],
        model = MODEL,
      ) => {
        const p = await client.query(
          `INSERT INTO product (slug, title, category_id)
           VALUES ($1, $2, (SELECT id FROM category WHERE path = $3)) RETURNING id`,
          [`${key}-${suffix}`, title, category],
        );
        const id = Number(p.rows[0].id);
        ids[key as keyof typeof ids] = id;
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                              current_price, currency, is_active, in_stock)
           VALUES ($1, $2, $3, $4, $3, $5, 'TRY', TRUE, TRUE)`,
          [merchant, id, `${key}-${suffix}`, `https://${suffix}.example.test/${key}`, price],
        );
        await client.query(
          `INSERT INTO product_text_embedding_d1024
             (product_id, model_version, text_version, content_hash, source_hash, embedding)
           VALUES ($1, $2, 1, decode(md5($3), 'hex'), decode(md5($3), 'hex'), $4::halfvec(1024))`,
          [id, model, key, literal(vector)],
        );
      };
      const word = `zqx${suffix}`;
      await make("run", `${word} kosu ayakkabisi`, SHOES, 100_000, axis(10));
      await make("walk", `${word} yuruyus ayakkabisi`, SHOES, 100_000, axis(10, 0.3));
      await make("bag", `${word} spor canta`, BAGS, 100_000, axis(10, 0.2));
      await make("pricey", `${word} pahali kosu ayakkabisi`, SHOES, 900_000, axis(10, 0.05));
      await make("semonly", "Hafif antrenman sneaker modeli", SHOES, 120_000, axis(10, 0.15));
      // Baska model: sorguya TAM yakin (kosinus 1.0) ama model uyusmuyor -> asla aday olmamali.
      await make("foreign", "Yabanci model hafif sneaker", SHOES, 100_000, axis(10), OTHER_MODEL);
      await client.query(
        `CREATE INDEX ${HNSW_NAME} ON product_text_embedding_d1024
           USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)
           WHERE model_version = '${MODEL}'`,
      );
      await client.query("ANALYZE product_text_embedding_d1024");
    });
    await refreshProductAggregates(db, { productIds: Object.values(ids) });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(`DROP INDEX IF EXISTS ${HNSW_NAME}`);
      await client.query("DELETE FROM product_text_embedding_d1024 WHERE model_version = ANY($1)", [
        [MODEL, OTHER_MODEL],
      ]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchant]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`%-${suffix}`]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchant]);
      for (const path of [SHOES, BAGS, ROOT]) {
        await client.query("DELETE FROM category WHERE path = $1", [path]);
      }
      // Siradaki dosyalarin plan secimleri (ornek `serving.integration.test.ts` EXPLAIN) bu dosyanin
      // gecici satirlarindan kalan bayat istatistiklerle etkilenmesin.
      await client.query("ANALYZE product, offer, category, product_text_embedding_d1024");
    });
  });

  const word = () => `zqx${suffix}`;
  const base = () => ({ vector: axis(10), modelVersion: MODEL, index: INDEX, text: "x" });

  it("EXPLAIN: kismi HNSW d1024 tablosunda global KNN'de kullanilabilir", async () => {
    const query = globalKnnSql({ ...base(), filters: {}, knnLimit: 10 });
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_sort = off`);
      const rows = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN (COSTS OFF) ${query}`);
      return rows.rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain(`Index Scan using ${HNSW_NAME}`);
  });

  it("envanter hazir indeksi (model, surum) okur; secici global_hnsw; baska model icin secmez", async () => {
    resetInventoryCache();
    const inventory = await loadSemanticInventory(db, INDEX);
    expect(inventory?.find((d) => d.id === HNSW_NAME)).toMatchObject({
      kind: "global_hnsw",
      modelVersion: MODEL,
      indexVersion: "1",
      state: "ready",
    });
    const pick = (modelVersion: string) =>
      selectSemanticStrategy({
        modelVersion,
        indexVersion: "1",
        category: null,
        hasPriceFilter: false,
        inventory: inventory ?? null,
        categoryStats: null,
        now: new Date(),
      }).strategy;
    expect(pick(MODEL)).toBe("global_hnsw");
    expect(pick(OTHER_MODEL)).toBe("legacy_postfilter");
  });

  it("MODEL KARISMAZ: baska model_version'in en yakin vektoru hicbir adayda yok", async () => {
    const global = (await findSemanticCandidates(db, { ...base(), filters: {} })).map(
      (c) => c.productId,
    );
    expect(global).toEqual(expect.arrayContaining([ids.run, ids.semonly]));
    expect(global).not.toContain(ids.foreign);
    const exact = (
      await findCategoryExactCandidates(db, {
        ...base(),
        filters: { category_path: SHOES, category_source: "explicit_ui" },
        categoryPath: SHOES,
        maxRows: 2000,
      })
    ).map((c) => c.productId);
    expect(exact).not.toContain(ids.foreign);
  });

  it("kesin kategori + fiyat suzgeci adaylari baglar", async () => {
    const out = (
      await findCategoryExactCandidates(db, {
        ...base(),
        filters: { category_path: SHOES, category_source: "explicit_ui", price_max: 500_000 },
        categoryPath: SHOES,
        maxRows: 2000,
      })
    ).map((c) => c.productId);
    expect(out).toEqual(expect.arrayContaining([ids.run, ids.walk, ids.semonly]));
    expect(out).not.toContain(ids.bag); // baska kategori
    expect(out).not.toContain(ids.pricey); // fiyat siniri
  });

  async function serve(
    filters: QueryObject["filters"],
    embedder: { vector: number[] } | null,
    text = `${word()} kosu`,
  ) {
    const lexical = await searchWithFallback(
      createPostgresSearchProvider(db),
      { parsed: parsed(text, filters), sort: "balanced", page: 1, pageSize: 24 },
      { aliases: createSeedAliasSource() },
    );
    const served = await applySemanticServing<RankedSearchItem>(
      db,
      {
        semanticText: "kosu ayakkabisi",
        queryText: "kosu ayakkabisi",
        filters,
        items: lexical.items,
        mode: lexical.mode,
        page: 1,
        sort: "balanced",
      },
      {
        env: { SEMANTIC_SEARCH_MODE: "on", SEMANTIC_INDEX_VERSION: "1" },
        resolveIndex: async () => ({ index: INDEX, source: "env" }),
        embedder: {
          modelVersion: MODEL,
          embedQuery: async () =>
            embedder ? { vector: embedder.vector, cacheHit: false, latencyMs: 1 } : null,
        },
        health: createProviderHealth(),
        usedToday: async () => 0,
        log: () => undefined,
      },
    );
    return { lexical, served };
  }

  it("uctan uca: metin sonuclari korunur, yalniz-anlamsal urun eklenir, fiyat siniri asilmaz, model karismaz", async () => {
    const { lexical, served } = await serve({ price_max: 500_000 }, { vector: axis(10) });
    expect(served.telemetry).toMatchObject({ outcome: "served", strategy: "global_hnsw" });
    const out = served.items.map((i) => i.productId);
    const lex = lexical.items.map((i) => i.productId);
    for (const id of lex) expect(out).toContain(id);
    expect(out.slice(0, lex.length)).toEqual(lex); // metin bloku ayni sirada basta
    expect(out).toContain(ids.semonly);
    expect(out).not.toContain(ids.pricey);
    expect(out).not.toContain(ids.foreign);
  });

  it("uctan uca: acik kategori filtresinde baska kategori eklenmez", async () => {
    const { served } = await serve(
      { category_path: SHOES, category_source: "explicit_ui", price_max: 500_000 },
      { vector: axis(10) },
    );
    const out = served.items.map((i) => i.productId);
    expect(out).not.toContain(ids.bag);
    expect(out).not.toContain(ids.pricey);
    expect(out).not.toContain(ids.foreign);
  });

  it("sorgu servisi vektor vermezse sonuc metin aramasinin BIREBIR aynisi", async () => {
    const { lexical, served } = await serve({ price_max: 500_000 }, null);
    expect(served.telemetry).toMatchObject({ outcome: "skipped", reason: "no_vector" });
    expect(served.items).toBe(lexical.items);
  });
});
