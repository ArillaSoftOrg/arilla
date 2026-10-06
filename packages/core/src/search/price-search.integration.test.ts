/**
 * Deterministik fiyat ifadeleri, /ara'nin GERCEK veri akisinda (karar 0066 fallback
 * hatti + price-patterns):
 *
 *   metin -> resolveQuery (parseQueryText + query_resolution onbellegi)
 *         -> searchWithFallback(createPostgresSearchProvider)
 *         -> search() -> PostgreSQL (product.min_price filtresi)
 *
 * Yalnizca yalitilmis yerel veritabaninda calisir (test-db.ts uzak adresi reddeder).
 * Fixture'lar kendi katalogunu kurar ve temizler; ayri bir calistirmada kalan
 * baska fixture'lar sonucu bozmasin diye her iddia KENDI urunlerimizin
 * kimligiyle yapilir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { createSeedAliasSource } from "./fallback/aliases.ts";
import { searchWithFallback } from "./fallback/pipeline.ts";
import { createPostgresSearchProvider } from "./fallback/postgres-provider.ts";
import { normalizeQueryText } from "./normalize.ts";
import { QUERY_PARSER_VERSION, resolveQuery } from "./query-resolution.ts";
import type { QueryObject } from "./types.ts";

const run = `pf${Date.now().toString(36)}`;

interface Fixture {
  key: string;
  title: string;
  brand: string;
  category: "elektronik/telefon" | "elektronik/laptop";
  /** TL; kurusa cevrilir. */
  tl: number;
}

const FIXTURES: Fixture[] = [
  {
    key: "s24",
    title: "Samsung Galaxy S24 128GB",
    brand: "Samsung",
    category: "elektronik/telefon",
    tl: 18_000,
  },
  {
    key: "a15",
    title: "Samsung Galaxy A15 128GB",
    brand: "Samsung",
    category: "elektronik/telefon",
    tl: 8_000,
  },
  {
    key: "s24u",
    title: "Samsung Galaxy S24 Ultra 512GB",
    brand: "Samsung",
    category: "elektronik/telefon",
    tl: 45_000,
  },
  {
    key: "a05",
    title: "Samsung Galaxy A05 64GB",
    brand: "Samsung",
    category: "elektronik/telefon",
    tl: 4_500,
  },
  {
    key: "ipmax",
    title: "Apple iPhone 17 Pro Max 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    tl: 55_000,
  },
  {
    key: "ipmax1tb",
    title: "Apple iPhone 17 Pro Max 1TB",
    brand: "Apple",
    category: "elektronik/telefon",
    tl: 72_000,
  },
  {
    key: "ip17",
    title: "Apple iPhone 17 128GB",
    brand: "Apple",
    category: "elektronik/telefon",
    tl: 38_000,
  },
  {
    key: "lenovo",
    title: "Lenovo IdeaPad 5 Laptop",
    brand: "Lenovo",
    category: "elektronik/laptop",
    tl: 16_000,
  },
  {
    key: "asus",
    title: "Asus TUF Gaming Laptop",
    brand: "Asus",
    category: "elektronik/laptop",
    tl: 24_000,
  },
  {
    key: "monster",
    title: "Monster Abra Laptop",
    brand: "Monster",
    category: "elektronik/laptop",
    tl: 32_000,
  },
  {
    key: "msi",
    title: "MSI Katana Laptop",
    brand: "MSI",
    category: "elektronik/laptop",
    tl: 52_000,
  },
];

/** Yalnizca yoksa eklenir ve yalnizca eklenenler silinir (paylasilan sozluge dokunma). */
const LEXICON_ROWS: [string, string, string][] = [
  ["category", "telefon", "elektronik/telefon"],
  ["category", "laptop", "elektronik/laptop"],
  ["brand", "samsung", "samsung"],
];

const slugs = new Map<string, string>(); // key -> slug
const productIds: number[] = [];
const brandIds: number[] = [];
const categoryIds: number[] = [];
const insertedLexiconIds: number[] = [];
const usedQueries = new Set<string>();
let merchantId = 0;

describe("deterministik fiyat ifadeleri - /ara akisi, gercek PostgreSQL", () => {
  let db: Database;

  async function search(text: string): Promise<{ parsed: QueryObject; keys: string[] }> {
    usedQueries.add(normalizeQueryText(text));
    const { parsed } = await resolveQuery(db, text);
    const outcome = await searchWithFallback(
      createPostgresSearchProvider(db),
      { parsed, sort: "balanced", page: 1, pageSize: 100 },
      { aliases: createSeedAliasSource() },
    );
    const bySlug = new Map([...slugs].map(([key, slug]) => [slug, key]));
    // Yalnizca KENDI fixture'larimiz: baska testlerin urunleri iddiayi etkilemesin.
    const keys = outcome.items
      .map((item) => bySlug.get(item.slug))
      .filter((key): key is string => key !== undefined);
    return { parsed, keys };
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
         VALUES ($1, 'PF Magaza', $2, 'xml_feed', 80) RETURNING id`,
        [`pf-${run}`, `pf-${run}.test`],
      );
      merchantId = Number(m.rows[0].id);

      const categories = new Map<string, number>();
      const categoryId = async (path: string): Promise<number> => {
        const cached = categories.get(path);
        if (cached) return cached;
        const found = await client.query("SELECT id FROM category WHERE path = $1", [path]);
        if (found.rows[0]) {
          categories.set(path, Number(found.rows[0].id));
          return Number(found.rows[0].id);
        }
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        const parent = parentPath ? await categoryId(parentPath) : null;
        const inserted = await client.query(
          "INSERT INTO category (slug, name, parent_id, path) VALUES ($1, $2, $3, $4) RETURNING id",
          [`${path.replace(/\//g, "-")}-${run}`, path.split("/").pop(), parent, path],
        );
        const id = Number(inserted.rows[0].id);
        categories.set(path, id);
        categoryIds.push(id);
        return id;
      };

      const brands = new Map<string, number>();
      let n = 0;
      for (const fixture of FIXTURES) {
        n++;
        let brandId = brands.get(fixture.brand);
        if (brandId === undefined) {
          const b = await client.query(
            "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
            [`${fixture.brand.toLowerCase()}-${run}`, fixture.brand, fixture.brand.toLowerCase()],
          );
          brandId = Number(b.rows[0].id);
          brands.set(fixture.brand, brandId);
          brandIds.push(brandId);
        }
        const slug = `pf-${run}-${fixture.key}`;
        slugs.set(fixture.key, slug);
        const kurus = fixture.tl * 100;
        const p = await client.query(
          `INSERT INTO product (slug, title, brand_id, category_id, min_price, primary_image_url, offer_count)
           VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING id`,
          [
            slug,
            fixture.title,
            brandId,
            await categoryId(fixture.category),
            kurus,
            `https://img.test/${run}/${n}.jpg`,
          ],
        );
        const productId = Number(p.rows[0].id);
        productIds.push(productId);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
          [merchantId, productId, slug, `https://pf-${run}.test/${n}`, fixture.title, kurus],
        );
      }

      for (const [kind, surface, normalized] of LEXICON_ROWS) {
        const inserted = await client.query(
          `INSERT INTO lexicon (kind, surface, normalized) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING id`,
          [kind, surface, normalized],
        );
        if (inserted.rows[0]) insertedLexiconIds.push(Number(inserted.rows[0].id));
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [
        [...usedQueries],
      ]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM brand WHERE id = ANY($1)", [brandIds]);
      for (const id of [...categoryIds].sort((a, b) => b - a)) {
        await client.query("DELETE FROM category WHERE id = $1", [id]);
      }
      await client.query("DELETE FROM lexicon WHERE id = ANY($1)", [insertedLexiconIds]);
    });
  });

  const sorted = (keys: string[]) => [...keys].sort();

  // ---- fiyat sinirlari: parser -> filtre -> SQL sonucu ------------------------------

  it.each([
    ["20 bin altı samsung telefon", { max: 2_000_000 }, ["a05", "a15", "s24"]],
    ["20k altı telefon", { max: 2_000_000 }, ["a05", "a15", "s24"]],
    ["20.000 TL altı telefon", { max: 2_000_000 }, ["a05", "a15", "s24"]],
    ["15 bin ile 25 bin arası laptop", { min: 1_500_000, max: 2_500_000 }, ["asus", "lenovo"]],
    ["5000 TL'den ucuz", { max: 500_000 }, ["a05"]],
    ["10 bin üstü telefon", { min: 1_000_000 }, ["ip17", "ipmax", "ipmax1tb", "s24", "s24u"]],
  ] as const)("%s", async (text, bounds, expectedKeys) => {
    const { parsed, keys } = await search(text);
    const filters = parsed.filters;
    expect(filters.price_min ?? undefined).toBe((bounds as { min?: number }).min);
    expect(filters.price_max ?? undefined).toBe((bounds as { max?: number }).max);
    expect(filters.currency).toBe("TRY");
    expect(sorted(keys)).toEqual([...expectedKeys].sort());
    // Fiyat ifadesi metin kapisina sizmadi: sonuc yalnizca fiyat+kategori+marka ile sinirli.
    expect(parsed.unparsed).toBe("");
  });

  it("'en fazla 30k' (yalniz fiyat): kendi katalogumuzdan <= 30.000 TL olanlarin hepsi, hicbir pahali olmayan", async () => {
    const { parsed, keys } = await search("en fazla 30k");
    expect(parsed.filters.price_max).toBe(3_000_000);
    expect(parsed.filters.price_min ?? undefined).toBeUndefined();
    expect(parsed.filters.currency).toBe("TRY");
    expect(sorted(keys)).toEqual(["a05", "a15", "asus", "lenovo", "s24"]);
  });

  it("'20 bin altı samsung telefon' marka ve kategoriyi de korur (Apple ve laptop yok)", async () => {
    const { parsed, keys } = await search("20 bin altı samsung telefon");
    expect(parsed.filters.brand_include).toEqual(["samsung"]);
    expect(parsed.filters.category_path).toBe("elektronik/telefon");
    expect(keys.every((key) => ["s24", "a15", "a05"].includes(key))).toBe(true);
  });

  // ---- model numarasi / ozellik fiyat degildir --------------------------------------

  it.each([
    ["iphone 17", ["ip17", "ipmax", "ipmax1tb"]],
    ["galaxy s24", ["s24", "s24u"]],
    ["a15", ["a15"]],
    ["128gb", ["a15", "ip17", "s24"]],
    ["256 gb ssd", []],
    ["16 gb ram", []],
  ] as const)("%s: fiyat filtresi YOK; metin aramasi calisir", async (text, mustInclude) => {
    const { parsed, keys } = await search(text);
    expect(parsed.filters.price_min ?? undefined).toBeUndefined();
    expect(parsed.filters.price_max ?? undefined).toBeUndefined();
    expect(parsed.filters.currency).toBeUndefined();
    // Fiyatla elenmedi: hem ucuz hem pahali eslesenler birlikte duruyor (varsa).
    for (const key of mustInclude) expect(keys, `${text} -> ${key}`).toContain(key);
  });

  it("karisik: 'iphone 17 pro max 60 bin altı' -> model 17 korunur, yalniz price_max = 60.000 TRY", async () => {
    const { parsed, keys } = await search("iphone 17 pro max 60 bin altı");
    expect(parsed.filters.price_max).toBe(6_000_000);
    expect(parsed.filters.price_min ?? undefined).toBeUndefined();
    expect(parsed.filters.currency).toBe("TRY");
    // Model metni metin kapisinda kalir, fiyat ifadesi degil.
    expect(parsed.unparsed).toBe("iphone 17 pro max");
    expect(keys).toContain("ipmax"); // 55.000 TL
    expect(keys).not.toContain("ipmax1tb"); // 72.000 TL > 60.000
    expect(keys).not.toContain("s24"); // baska model
  });

  // ---- onbellek -----------------------------------------------------------------------

  it("onbellekten gelen ayristirma (JSONB gidis-donus) fiyat ve para birimini korur", async () => {
    const first = await resolveQuery(db, "20 bin altı samsung telefon");
    const second = await resolveQuery(db, "20 bin altı samsung telefon");
    expect(second.cacheHit).toBe(true);
    expect(second.parsed.filters.price_max).toBe(2_000_000);
    expect(second.parsed.filters.currency).toBe("TRY");
    expect(second.parsed).toEqual(first.parsed);
  });

  it("eski parser surumunden kalan 2. kademe satir TEK SATIR olarak yenilenir; tablo, 3. kademe ve komsu satirlar korunur", async () => {
    const staleQuery = "ucuz kulaklik 3 bin altı stale";
    const modelQuery = "model kademesi 3 bin altı stale";
    const neighbourQuery = "komsu satir 3 bin altı stale";
    for (const text of [staleQuery, modelQuery, neighbourQuery])
      usedQueries.add(normalizeQueryText(text));
    const legacy = (text: string) =>
      JSON.stringify({
        intent: "browse",
        anchor: null,
        text,
        filters: {},
        style_tags: [],
        sort: "balanced",
        unparsed: "3 bin altı",
        confidence: 0,
      });
    await withOwnerClient(async (client) => {
      for (const [text, tier] of [
        [staleQuery, 2],
        [modelQuery, 3],
        [neighbourQuery, 2],
      ] as const) {
        await client.query(
          `INSERT INTO query_resolution (query_norm, parsed, parser_tier) VALUES ($1, $2, $3)
           ON CONFLICT (query_norm) DO UPDATE SET parsed = EXCLUDED.parsed, parser_tier = EXCLUDED.parser_tier`,
          [normalizeQueryText(text), legacy(text), tier],
        );
      }
    });
    const row = async (text: string) =>
      withOwnerClient(async (client) => {
        const r = await client.query(
          "SELECT parsed, parser_tier, hit_count FROM query_resolution WHERE query_norm = $1",
          [normalizeQueryText(text)],
        );
        return r.rows[0] as { parsed: QueryObject; parser_tier: number; hit_count: number };
      });

    // 1) Bayat 2. kademe satir: yeni parser devreye girer, satir damgalanir.
    const first = await resolveQuery(db, staleQuery);
    expect(first.cacheHit).toBe(false);
    expect(first.parsed.filters.price_max).toBe(300_000);
    expect(first.parsed.filters.currency).toBe("TRY");
    const refreshed = await row(staleQuery);
    expect(refreshed.parsed.parser_version).toBe(QUERY_PARSER_VERSION);
    expect(refreshed.parsed.filters.price_max).toBe(300_000);
    expect(refreshed.parser_tier).toBe(2);
    // Bir sonraki okuma artik onbellek isabeti.
    expect((await resolveQuery(db, staleQuery)).cacheHit).toBe(true);

    // 2) Model kademesi (3): eski olsa da DOKUNULMAZ.
    const model = await resolveQuery(db, modelQuery);
    expect(model.cacheHit).toBe(true);
    expect(model.parsed.filters.price_max).toBeUndefined();
    expect((await row(modelQuery)).parsed.parser_version).toBeUndefined();

    // 3) Okunmayan komsu satir: kendiliginden degismez (tembel, satir bazli).
    const neighbour = await row(neighbourQuery);
    expect(neighbour.parsed.parser_version).toBeUndefined();
    expect(neighbour.hit_count).toBe(1);
  });
});
