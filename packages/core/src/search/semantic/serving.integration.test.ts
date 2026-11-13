/**
 * Kategori kaynagi + anlamsal sunum (karar 0190), gercek PostgreSQL + pgvector.
 *
 * Dogrulananlar:
 * - EXPLAIN: global sablon, `model_version = '<model>'` kosullu kismi HNSW'yi GENEL planda da
 *   kullanir (model sabit metin). Ayni sorgu model PARAMETRE iken genel planda kullanamaz (neden
 *   sabit sablon). Kategori ici kesin sablon `product_category_idx` + PK ile okur, vektor tablosunu
 *   taramaz. Kucuk test tablosunda planlayici tam taramayi secebilecegi icin plan sekli
 *   `enable_seqscan = off` ile denetlenir: bu, indeksin bu sorgu bicimiyle KULLANILABILIR oldugunu
 *   kanitlar; buyuk veride secildigi E3-d / E3-d.1'de olculdu.
 * - Envanter `pg_index`ten okunur: hazir indeks `ready`, model/surum dogru.
 * - SQL enjeksiyonu: kategori yolu parametredir, model adi dar desenle dogrulanir.
 * - Uctan uca sunum: fiyat siniri, acik kategoride kategorisiz urun dislanir, ipucunda dislanmaz,
 *   havuz tasmasi eksik sonuc vermez.
 * - Metin aramasi: ipucu yalniz siralama (dislamaz); `explicit_ui` gevsetilmez,
 *   `explicit_text_verified` ust kategoriye gevser.
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
import { cardsForProducts } from "../search.ts";
import { categoryPathExists, prepareSearchFilters } from "../search-domain.ts";
import type { QueryFilters, QueryObject } from "../types.ts";
import type { SemanticIndex } from "./active-index.ts";
import { loadSemanticInventory, resetInventoryCache } from "./inventory.ts";
import { createProviderHealth } from "./provider-health.ts";
import {
  exactCategoryKnnSql,
  findCategoryExactCandidates,
  findSemanticCandidates,
  globalKnnSql,
  SemanticPoolOverflowError,
} from "./semantic-candidates.ts";
import { applySemanticServing } from "./serving.ts";
import { selectSemanticStrategy } from "./strategy.ts";

const MODEL = "test-serving-model";
const suffix = `t${Date.now()}`;
const ROOT = `zs${suffix}`;
const SHOES = `${ROOT}/ayakkabi`;
const RUN = `${SHOES}/kosu`;
const WALK = `${SHOES}/yuruyus`;
const BAGS = `${ROOT}/canta`;
const HNSW_NAME = `pte_hnsw_${suffix}_v1`;
const INDEX: SemanticIndex = {
  modelVersion: MODEL,
  table: "product_text_embedding",
  dimensions: 768,
  queryTask: "retrieval.query",
};

function axis(index: number, tilt = 0): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[index] = 1;
  if (tilt > 0) vector[index + 1] = tilt;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

const literal = (v: number[]) => `[${v.join(",")}]`;

/**
 * `noSort`: kucuk paylasilan test tablosunda `(model_version, content_hash)` B-tree'si + Sort
 * ucuz gorunur; Sort'u cezalandirmak HNSW'nin bu sorgu BICIMIYLE secilebildigini gosterir.
 */
async function explain(
  db: Database,
  query: ReturnType<typeof globalKnnSql>,
  noSort = false,
): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    if (noSort) await tx.execute(sql`SET LOCAL enable_sort = off`);
    const rows = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN (COSTS OFF) ${query}`);
    return rows.rows.map((r) => r["QUERY PLAN"]).join("\n");
  });
}

function parsedQuery(text: string, filters: QueryFilters): QueryObject {
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

describe("kategori kaynagi + anlamsal sunum (gercek PG)", () => {
  let db: Database;
  let merchant = 0;
  // Anahtarlar beforeAll'da doldurulur; tip `number` (tanimsiz anahtar testte hataya yol acar).
  const ids = {} as Record<"run" | "walk" | "bag" | "nocat" | "pricey" | "semonly", number>;
  const categoryIds: Record<string, number> = {};

  beforeAll(async () => {
    db = getTestDb();
    resetInventoryCache();
    await withOwnerClient(async (client) => {
      for (const [key, path] of Object.entries({ ROOT, SHOES, RUN, WALK, BAGS })) {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        const c = await client.query(
          `INSERT INTO category (slug, name, path, parent_id)
           VALUES ($1, $2, $3, (SELECT id FROM category WHERE path = $4)) RETURNING id`,
          [path.replaceAll("/", "-"), key, path, parent],
        );
        categoryIds[path] = Number(c.rows[0].id);
      }
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
         VALUES ($1, $2, $3, 'xml_feed', TRUE, 80) RETURNING id`,
        [`m-${suffix}`, `Sunum ${suffix}`, `${suffix}.example.test`],
      );
      merchant = Number(m.rows[0].id);
      const make = async (
        key: string,
        title: string,
        category: string | null,
        price: number,
        vector: number[] | null,
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
        if (vector) {
          await client.query(
            `INSERT INTO product_text_embedding
               (product_id, model_version, text_version, content_hash, source_hash, embedding)
             VALUES ($1, $2, 1, decode(md5($3), 'hex'), decode(md5($3), 'hex'), $4::halfvec(768))`,
            [id, MODEL, key, literal(vector)],
          );
        }
      };
      // Metin aramasi icin ortak, nadir bir bas isim: `zqx<suffix>`.
      const word = `zqx${suffix}`;
      await make("run", `${word} kosu ayakkabisi`, RUN, 100_000, axis(10));
      await make("walk", `${word} yuruyus ayakkabisi`, WALK, 100_000, axis(10, 0.3));
      await make("bag", `${word} spor canta`, BAGS, 100_000, axis(10, 0.2));
      await make("nocat", `${word} kategorisiz ayakkabi`, null, 100_000, axis(10, 0.1));
      await make("pricey", `${word} pahali kosu ayakkabisi`, RUN, 900_000, axis(10, 0.05));
      await make("semonly", "Hafif antrenman sneaker modeli", RUN, 120_000, axis(10, 0.15));
      await client.query(
        `CREATE INDEX ${HNSW_NAME} ON product_text_embedding
           USING hnsw (embedding halfvec_cosine_ops) WHERE model_version = '${MODEL}'`,
      );
      await client.query("ANALYZE product_text_embedding");
    });
    await refreshProductAggregates(db, { productIds: Object.values(ids) });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(`DROP INDEX IF EXISTS ${HNSW_NAME}`);
      await client.query("DELETE FROM product_text_embedding WHERE model_version = $1", [MODEL]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchant]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`%-${suffix}`]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchant]);
      // Cocuktan koke (parent_id FK).
      const paths = await client.query(
        "SELECT path FROM category WHERE path = $1 OR path LIKE $2 ORDER BY length(path) DESC",
        [ROOT, `${ROOT}/%`],
      );
      for (const row of paths.rows) {
        await client.query("DELETE FROM category WHERE path = $1", [row.path]);
      }
    });
  });

  const word = () => `zqx${suffix}`;

  describe("EXPLAIN: sablonlar dogru indeksi kullanir", () => {
    it("global sablon: kismi HNSW, genel planda da (model sabit metin)", async () => {
      // Kucuk test tablosunda LIMIT buyudukce planlayici B-tree + Sort secer; 102k satirda
      // LIMIT 400 dahil HNSW secildi (yerel olcum, karar 0190). Burada sorgu BICIMI denetlenir.
      const query = globalKnnSql({
        vector: axis(10),
        modelVersion: MODEL,
        index: INDEX,
        text: "x",
        filters: {},
        knnLimit: 10,
      });
      const plan = await explain(db, query, true);
      expect(plan).toContain(`Index Scan using ${HNSW_NAME}`);

      // Genel plan: PREPARE + force_generic_plan. Vektor parametre, model sabit -> indeks kullanilir.
      const generic = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql`SET LOCAL enable_sort = off`);
        await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
        await tx.execute(
          sql.raw(`PREPARE g_${suffix}(halfvec) AS SELECT product_id FROM product_text_embedding
                   WHERE model_version = '${MODEL}' ORDER BY embedding <=> $1 LIMIT 10`),
        );
        const r = await tx.execute<{ "QUERY PLAN": string }>(
          sql.raw(`EXPLAIN (COSTS OFF) EXECUTE g_${suffix}('${literal(axis(10))}')`),
        );
        await tx.execute(sql.raw(`DEALLOCATE g_${suffix}`));
        return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
      });
      expect(generic).toContain(HNSW_NAME);
    });

    it("model PARAMETRE + genel plan: kismi HNSW kullanilamaz (sabit sablonun nedeni)", async () => {
      const generic = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql`SET LOCAL enable_sort = off`);
        await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
        await tx.execute(
          sql.raw(`PREPARE p_${suffix}(halfvec, text) AS SELECT product_id FROM product_text_embedding
                   WHERE model_version = $2 ORDER BY embedding <=> $1 LIMIT 10`),
        );
        const r = await tx.execute<{ "QUERY PLAN": string }>(
          sql.raw(`EXPLAIN (COSTS OFF) EXECUTE p_${suffix}('${literal(axis(10))}', '${MODEL}')`),
        );
        await tx.execute(sql.raw(`DEALLOCATE p_${suffix}`));
        return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
      });
      expect(generic).not.toContain(HNSW_NAME);
    });

    it("kategori ici kesin sablon: category_idx + PK; vektor tablosu taranmaz, HNSW kullanilmaz", async () => {
      const query = exactCategoryKnnSql({
        vector: axis(10),
        modelVersion: MODEL,
        index: INDEX,
        text: "x",
        filters: {},
        categoryPath: SHOES,
        poolLimit: 2001,
      });
      const plan = await explain(db, query);
      expect(plan).toContain("product_category_idx");
      expect(plan).toContain("product_text_embedding_pkey");
      expect(plan).not.toMatch(/Seq Scan on product_text_embedding/);
      expect(plan).not.toContain(HNSW_NAME);
    });
  });

  describe("envanter ve secici", () => {
    it("pg_index'ten hazir indeks okunur; secici global_hnsw secer", async () => {
      resetInventoryCache();
      const inventory = await loadSemanticInventory(db, INDEX);
      const mine = inventory?.find((d) => d.id === HNSW_NAME);
      expect(mine).toMatchObject({
        kind: "global_hnsw",
        modelVersion: MODEL,
        indexVersion: "1",
        state: "ready",
      });
      expect(inventory?.some((d) => d.kind === "btree_category" && d.state === "ready")).toBe(true);
      const decision = selectSemanticStrategy({
        modelVersion: MODEL,
        indexVersion: "1",
        category: null,
        hasPriceFilter: false,
        inventory: inventory ?? null,
        categoryStats: null,
        now: new Date(),
      });
      expect(decision).toMatchObject({ strategy: "global_hnsw", indexId: HNSW_NAME });
      // Baska model icin bu indeks secilmez.
      expect(
        selectSemanticStrategy({
          modelVersion: "jina-embeddings-v3-other",
          category: null,
          hasPriceFilter: false,
          inventory: inventory ?? null,
          categoryStats: null,
          now: new Date(),
        }).strategy,
      ).toBe("legacy_postfilter");
    });
  });

  describe("SQL enjeksiyonu", () => {
    it.each([`${SHOES}' OR '1'='1`, `${SHOES}%`, "'; DROP TABLE product; --", `${SHOES}/_`])(
      "guvensiz yol SQL'e hic gitmez: %s",
      async (path) => {
        await expect(
          findCategoryExactCandidates(db, {
            vector: axis(10),
            modelVersion: MODEL,
            index: INDEX,
            text: "x",
            filters: {},
            categoryPath: path,
            maxRows: 2000,
          }),
        ).rejects.toThrow("kategori yolu");
        expect(await categoryPathExists(db, path)).toBe(false);
      },
    );

    it("guvenli ama olmayan yol parametre olarak gider: bos sonuc", async () => {
      const out = await findCategoryExactCandidates(db, {
        vector: axis(10),
        modelVersion: MODEL,
        index: INDEX,
        text: "x",
        filters: {},
        categoryPath: `${ROOT}/yok`,
        maxRows: 2000,
      });
      expect(out).toEqual([]);
    });

    it("model adi dar desen disindaysa SQL'e girmez", async () => {
      await expect(
        findSemanticCandidates(db, {
          vector: axis(10),
          modelVersion: "x' OR '1'='1",
          index: INDEX,
          text: "x",
          filters: {},
        }),
      ).rejects.toThrow("model_version");
    });

    it("product tablosu hala yerinde", async () => {
      const r = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM product WHERE slug LIKE ${`%-${suffix}`}`,
      );
      expect(r.rows[0]?.n).toBe(6);
    });
  });

  describe("aday sablonlari: fiyat, kategori, kategorisiz", () => {
    const base = { vector: axis(10), modelVersion: MODEL, index: INDEX, text: "x" };

    it("acik kategori (kesin): kategorisiz ve baska kategori dislanir; fiyat siniri dogru", async () => {
      const filters: QueryFilters = {
        category_path: SHOES,
        category_source: "explicit_ui",
        price_max: 500_000,
      };
      const out = (
        await findCategoryExactCandidates(db, {
          ...base,
          filters,
          categoryPath: SHOES,
          maxRows: 2000,
        })
      ).map((c) => c.productId);
      expect(out).toEqual(expect.arrayContaining([ids.run, ids.walk, ids.semonly]));
      expect(out).not.toContain(ids.nocat);
      expect(out).not.toContain(ids.bag);
      expect(out).not.toContain(ids.pricey);
    });

    it("ipucu (yumusak): global aday kategorisiz ve baska kategoriyi DISLAMAZ", async () => {
      const out = (
        await findSemanticCandidates(db, { ...base, filters: { category_hint: SHOES } })
      ).map((c) => c.productId);
      expect(out).toEqual(expect.arrayContaining([ids.nocat, ids.bag, ids.run]));
    });

    it("havuz tasmasi: eksik sonuc yerine hata", async () => {
      await expect(
        findCategoryExactCandidates(db, { ...base, filters: {}, categoryPath: SHOES, maxRows: 1 }),
      ).rejects.toBeInstanceOf(SemanticPoolOverflowError);
    });

    it("kart hidrasyonu metin aramasinin suzgecini uygular", async () => {
      const cards = await cardsForProducts(db, [ids.pricey, ids.run, ids.nocat], {
        category_path: SHOES,
        category_source: "explicit_ui",
        price_max: 500_000,
      });
      expect(cards.map((c) => c.productId)).toEqual([ids.run]);
    });
  });

  describe("uctan uca sunum (sahte embedder, gercek SQL)", () => {
    it("acik mod + hazir indeks: yalniz-anlamsal urun eklenir, metin sonucu korunur", async () => {
      const lexical = await searchWithFallback(
        createPostgresSearchProvider(db),
        {
          parsed: parsedQuery(`${word()} kosu`, { price_max: 500_000 }),
          sort: "balanced",
          page: 1,
          pageSize: 24,
        },
        { aliases: createSeedAliasSource() },
      );
      expect(lexical.items.map((i) => i.productId)).not.toContain(ids.semonly);
      expect(lexical.items.map((i) => i.productId)).not.toContain(ids.pricey);
      const served = await applySemanticServing<RankedSearchItem>(
        db,
        {
          semanticText: "kosu ayakkabisi",
          queryText: "kosu ayakkabisi",
          filters: { price_max: 500_000 },
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
            embedQuery: async () => ({ vector: axis(10), cacheHit: false, latencyMs: 1 }),
          },
          health: createProviderHealth(),
          usedToday: async () => 0,
          log: () => undefined,
        },
      );
      expect(served.telemetry).toMatchObject({ outcome: "served", strategy: "global_hnsw" });
      const out = served.items.map((i) => i.productId);
      for (const item of lexical.items) expect(out).toContain(item.productId);
      expect(out).toContain(ids.semonly);
      expect(out).not.toContain(ids.pricey);
    });
  });

  describe("metin aramasi: kategori kaynagi", () => {
    const run = (filters: QueryFilters) =>
      searchWithFallback(
        createPostgresSearchProvider(db),
        { parsed: parsedQuery(word(), filters), sort: "balanced", page: 1, pageSize: 24 },
        { aliases: createSeedAliasSource() },
      );

    it("ipucu yalniz siralama: dislamaz, ipucu kategorisi one cikar", async () => {
      const none = (await run({})).items.map((i) => i.productId);
      const hinted = (await run({ category_hint: BAGS })).items.map((i) => i.productId);
      expect(new Set(hinted)).toEqual(new Set(none));
      expect(hinted).toContain(ids.nocat);
      expect(hinted.indexOf(ids.bag)).toBeLessThan(none.indexOf(ids.bag) + 1);
      expect(hinted[0]).toBe(ids.bag);
    });

    it("explicit_ui kesin: kategorisiz ve baska kategori yok", async () => {
      const out = (await run({ category_path: SHOES, category_source: "explicit_ui" })).items.map(
        (i) => i.productId,
      );
      expect(out).toEqual(expect.arrayContaining([ids.run, ids.walk]));
      expect(out).not.toContain(ids.nocat);
      expect(out).not.toContain(ids.bag);
    });

    it("bos alt kategori: explicit_ui gevsetilmez, explicit_text_verified ust kategoriye gevser", async () => {
      await withOwnerClient(async (client) => {
        await client.query(
          `INSERT INTO category (slug, name, path, parent_id) VALUES ($1, 'bos', $2, $3)`,
          [`${SHOES}-bos`.replaceAll("/", "-"), `${SHOES}/bos`, categoryIds[SHOES]],
        );
      });
      const ui = await run({ category_path: `${SHOES}/bos`, category_source: "explicit_ui" });
      expect(ui.items).toEqual([]);
      const text = await run({
        category_path: `${SHOES}/bos`,
        category_source: "explicit_text_verified",
      });
      expect(text.items.map((i) => i.productId)).toEqual(
        expect.arrayContaining([ids.run, ids.walk]),
      );
      expect(text.trace.relaxed).toContain("category");
    });

    it("katalogda olmayan metin kategorisi ipucuna duser (sifir sonuc yerine)", async () => {
      const prepared = await prepareSearchFilters(
        db,
        parsedQuery(word(), {
          category_path: `${ROOT}/yok`,
          category_source: "explicit_text_verified",
        }),
      );
      expect(prepared.filters).toEqual({ category_hint: `${ROOT}/yok` });
      const known = await prepareSearchFilters(
        db,
        parsedQuery(word(), { category_path: SHOES, category_source: "explicit_text_verified" }),
      );
      expect(known.filters.category_path).toBe(SHOES);
    });
  });
});
