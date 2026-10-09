/**
 * Fallback pipeline + `createPostgresSearchProvider`, GERCEK yerel Postgres
 * (karar 0066). Yalnizca yalitilmis yerel veritabaninda calisir (test-db.ts
 * uzak adresi reddeder). Fixture'lar kendi katalogunu kurar ve temizler.
 *
 * Katalog bilerek "iPhone 17 Pro Max YOK, 16 Pro Max VAR" kurgusudur.
 */
import { createDatabase, type Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../../test-db.ts";
import { loadLexicon } from "../lexicon-repository.ts";
import { parseQueryText } from "../parse-query.ts";
import { createSeedAliasSource } from "./aliases.ts";
import { searchWithFallback } from "./pipeline.ts";
import { createPostgresSearchProvider } from "./postgres-provider.ts";
import type { FallbackSearchOutcome } from "./types.ts";

interface Fixture {
  title: string;
  brand?: string;
  category: string;
  color?: string;
  price: number;
  image?: string;
}

const FIXTURES: Fixture[] = [
  {
    title: "Apple iPhone 16 Pro Max 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "black",
    price: 7_500_000,
  },
  {
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "black",
    price: 8_200_000,
    image: "a",
  },
  // Ayni urunun ikinci satiri (farkli gorsel): kopya olarak tek gorunmeli.
  {
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "black",
    price: 8_300_000,
    image: "b",
  },
  {
    title: "Apple iPhone 17 128GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "white",
    price: 6_400_000,
  },
  {
    title: "Apple iPhone 16 128GB",
    brand: "Apple",
    category: "elektronik/telefon",
    color: "white",
    price: 5_200_000,
  },
  { title: "Apple AirPods Pro 2", brand: "Apple", category: "elektronik/kulaklik", price: 800_000 },
  {
    title: "Samsung Galaxy S23 256GB",
    brand: "Samsung",
    category: "elektronik/telefon",
    color: "black",
    price: 4_000_000,
  },
  {
    title: "Sony Bluetooth Headphone WH-100",
    brand: "Sony",
    category: "elektronik/kulaklik",
    color: "black",
    price: 300_000,
  },
  {
    title: "Philips Kablosuz Kulaklık TA-200",
    brand: "Philips",
    category: "elektronik/kulaklik",
    color: "black",
    price: 250_000,
  },
  { title: "Dyson V15 Vacuum Cleaner", brand: "Dyson", category: "ev-yasam", price: 2_000_000 },
  {
    title: "Nike Pegasus Koşu Ayakkabısı",
    brand: "Nike",
    category: "moda/ayakkabi/kosu",
    color: "red",
    price: 450_000,
  },
  {
    title: "Nike Revolution Koşu Ayakkabısı",
    brand: "Nike",
    category: "moda/ayakkabi/kosu",
    color: "black",
    price: 300_000,
  },
  {
    title: "Adidas Duramo Koşu Ayakkabısı",
    brand: "Adidas",
    category: "moda/ayakkabi/kosu",
    color: "red",
    price: 280_000,
  },
  {
    title: "Nike Spor Çanta",
    brand: "Nike",
    category: "moda/canta",
    color: "black",
    price: 120_000,
  },
];

const LEXICON_ROWS: [string, string, string][] = [
  ["brand", "nike", "nike"],
  ["brand", "samsung", "samsung"],
  ["color", "mavi", "blue"],
  ["color", "kırmızı", "red"],
  ["category", "koşu ayakkabısı", "moda/ayakkabi/kosu"],
];

const run = `sf${Date.now().toString(36)}`;
const productIds: number[] = [];
const brandIds: number[] = [];
const categoryIds: number[] = [];
let merchantId = 0;

/** Veritabanina giden SQL ifadelerini sayar (execute/select; islem icindekiler dahil). */
function counting(db: Database): { db: Database; count: () => number; reset: () => void } {
  let calls = 0;
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        if (typeof value !== "function") return value;
        if (key === "execute" || key === "select") {
          return (...args: unknown[]) => {
            calls++;
            return value.apply(obj, args);
          };
        }
        if (key === "transaction") {
          return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
            value.call(obj, (tx: object) => fn(wrap(tx)), ...rest);
        }
        return value.bind(obj);
      },
    });
  return { db: wrap(db) as Database, count: () => calls, reset: () => (calls = 0) };
}

describe("non-AI fallback - gercek PostgreSQL", () => {
  let db: Database;
  let meter: ReturnType<typeof counting>;

  async function find(text: string): Promise<FallbackSearchOutcome> {
    const lexicon = await loadLexicon(db);
    return searchWithFallback(
      createPostgresSearchProvider(meter.db),
      { parsed: parseQueryText(text, lexicon), sort: "balanced", page: 1, pageSize: 24 },
      { aliases: createSeedAliasSource() },
    );
  }
  const titles = (outcome: FallbackSearchOutcome) => outcome.items.map((item) => item.title);
  /** Yalnizca bu dosyanin fixture urunleri: tohum katalogu ayni kelimeleri tasiyabilir. */
  const fixtureTitles = (outcome: FallbackSearchOutcome) =>
    outcome.items.filter((item) => productIds.includes(item.productId)).map((item) => item.title);

  beforeAll(async () => {
    db = getTestDb();
    meter = counting(db);
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
         VALUES ($1, 'SF Magaza', $2, 'xml_feed', 80) RETURNING id`,
        [`sf-${run}`, `sf-${run}.test`],
      );
      merchantId = Number(m.rows[0].id);

      const brands = new Map<string, number>();
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

      let n = 0;
      for (const fixture of FIXTURES) {
        n++;
        let brandId: number | null = null;
        if (fixture.brand) {
          brandId = brands.get(fixture.brand) ?? null;
          if (brandId === null) {
            const b = await client.query(
              "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
              [`${fixture.brand.toLowerCase()}-${run}`, fixture.brand, fixture.brand.toLowerCase()],
            );
            brandId = Number(b.rows[0].id);
            brands.set(fixture.brand, brandId);
            brandIds.push(brandId);
          }
        }
        const p = await client.query(
          `INSERT INTO product (slug, title, brand_id, category_id, color, min_price, primary_image_url, offer_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING id`,
          [
            `sf-${run}-${n}`,
            fixture.title,
            brandId,
            await categoryId(fixture.category),
            fixture.color ?? null,
            fixture.price,
            fixture.image
              ? `https://img.test/${run}/${fixture.image}.jpg`
              : `https://img.test/${run}/p${n}.jpg`,
          ],
        );
        const productId = Number(p.rows[0].id);
        productIds.push(productId);
        await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
          [
            merchantId,
            productId,
            `sf-${run}-${n}`,
            `https://sf-${run}.test/${n}`,
            fixture.title,
            fixture.price,
          ],
        );
      }
      for (const [kind, surface, normalized] of LEXICON_ROWS) {
        await client.query(
          "INSERT INTO lexicon (kind, surface, normalized) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [kind, surface, normalized],
        );
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM brand WHERE id = ANY($1)", [brandIds]);
      // Alt kategoriler once (parent_id FK): son eklenen en derin.
      for (const id of [...categoryIds].sort((a, b) => b - a)) {
        await client.query("DELETE FROM category WHERE id = $1", [id]);
      }
      for (const [kind, surface] of LEXICON_ROWS) {
        await client.query("DELETE FROM lexicon WHERE kind = $1 AND surface = $2", [kind, surface]);
      }
    });
  });

  // ---- extension / yapilandirma -------------------------------------------------

  it("pg_trgm yuklu ve ihtiyac duyulan fonksiyon/operatorler var", async () => {
    const ext = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext.rows).toHaveLength(1);
    const probe = await db.execute(
      sql`SELECT strict_word_similarity('iphone', 'apple iphone 17') AS s, 'iphone' <<% 'apple iphone 17' AS m`,
    );
    expect(Number(probe.rows[0]?.s)).toBeGreaterThan(0.5);
    expect(probe.rows[0]?.m).toBe(true);
  });

  it("fuzzy esik ayari islem-yerel: havuzdaki baglantiya SIZMAZ", async () => {
    vi.stubEnv("DATABASE_POOL_MAX", "1"); // tek baglanti: sizinti varsa AYNI baglantida gorulur
    const url = process.env.DATABASE_URL as string;
    const single = createDatabase(url);
    try {
      // `pg_trgm.*` ayari modul yuklenince tanimlanir: once bir trigram sorgusu.
      await single.execute(sql`SELECT 'a' <<% 'a'`);
      const guc = async () =>
        String(
          (
            await single.execute(
              sql`SELECT current_setting('pg_trgm.strict_word_similarity_threshold') AS v`,
            )
          ).rows[0]?.v,
        );
      const before = await guc();
      await createPostgresSearchProvider(single).search({
        text: "airpdos pro",
        slots: [["airpdos"], ["pro"]],
        filters: {},
        sort: "balanced",
        limit: 5,
        offset: 0,
        fuzzy: true,
      });
      expect(await guc()).toBe(before);
      expect(Number(before)).toBeCloseTo(0.5, 5); // varsayilan korunur
    } finally {
      vi.unstubAllEnvs();
      await (single as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  });

  // ---- asamalar -------------------------------------------------------------------

  it("exact: birebir urun, tek DB sorgusu cifti, kopya tek satir", async () => {
    meter.reset();
    const outcome = await find("iphone 17 pro");
    expect(outcome.mode).toBe("results");
    expect(outcome.trace.stage).toBe("exact");
    expect(titles(outcome)).toEqual(["Apple iPhone 17 Pro 256GB"]);
    expect(outcome.items.filter((i) => i.title === "Apple iPhone 17 Pro 256GB")).toHaveLength(1);
  });

  it("alias: tohum takma adi ('supurge' -> 'vacuum')", async () => {
    const outcome = await find("süpürge");
    expect(outcome.mode).toBe("results");
    expect(outcome.trace.stage).toBe("alias");
    expect(titles(outcome)).toEqual(["Dyson V15 Vacuum Cleaner"]);
  });

  it("typo/fuzzy: 'airpdos pro'", async () => {
    const outcome = await find("airpdos pro");
    expect(outcome.mode).toBe("results");
    expect(titles(outcome)).toEqual(["Apple AirPods Pro 2"]);
  });

  it("model numarasi korunur: 17 Pro Max yok, 16 Pro Max NORMAL sonuc degil", async () => {
    const outcome = await find("iphone 17 pro max");
    expect(outcome.mode).toBe("fallback");
    expect(outcome.items.every((item) => item.match.tier !== "exact")).toBe(true);
    const shown = titles(outcome);
    expect(shown[0]).toBe("Apple iPhone 17 Pro 256GB"); // variant_relaxed
    expect(outcome.items[0]?.match.stage).toBe("variant_relaxed");
    // exact adim aday getirdi (yazim hatasi degil): bulanik tur calismaz.
    expect(outcome.trace.stagesTried).not.toContain("fuzzy");
    const sixteen = outcome.items.find((item) => item.title.includes("16 Pro Max"));
    // Gorunuyorsa yalnizca ilgili (related) katmaninda ve 17'lerden sonra.
    if (sixteen) {
      expect(sixteen.match.tier).toBe("related");
      expect(shown.indexOf(sixteen.title)).toBeGreaterThan(shown.indexOf("Apple iPhone 17 128GB"));
    }
  });

  it("'iphone 15' (var olmayan nesil) normal sonuc dondurmez", async () => {
    const outcome = await find("iphone 15");
    expect(outcome.mode).not.toBe("results");
    expect(outcome.items.every((item) => item.match.tier !== "exact")).toBe(true);
  });

  it("'galaxy s24' S23'u normal sonuc gibi gostermez", async () => {
    const outcome = await find("galaxy s24");
    expect(outcome.mode).not.toBe("results");
    for (const item of outcome.items) {
      expect(item.match.tier).not.toBe("exact");
      expect(item.title).toContain("Samsung");
    }
  });

  it("constraint_relaxed: renk gevsetilir, marka ve kategori kalir", async () => {
    const outcome = await find("mavi nike koşu ayakkabısı");
    expect(outcome.mode).toBe("fallback");
    expect(titles(outcome).sort()).toEqual([
      "Nike Pegasus Koşu Ayakkabısı",
      "Nike Revolution Koşu Ayakkabısı",
    ]);
    expect(outcome.items.every((item) => item.match.relaxed.includes("color"))).toBe(true);
    expect(outcome.trace.stagesTried).toContain("constraint_relaxed");
  });

  it("related: hem token hem kisit gevsetilmis son adim", async () => {
    const outcome = await find("mavi iphone 17 pro max");
    expect(outcome.trace.stagesTried).toContain("related");
    expect(outcome.mode).toBe("fallback");
    expect(outcome.items.every((item) => item.match.tier !== "exact")).toBe(true);
  });

  it("fiyat kisiti hicbir adimda gevsemez", async () => {
    const outcome = await find("iphone 17 pro max 70000 tl altı");
    for (const item of outcome.items) expect(item.minPrice ?? 0).toBeLessThanOrEqual(7_000_000);
    expect(titles(outcome)).not.toContain("Apple iPhone 17 Pro 256GB");
  });

  it("marka kisiti: 'samsung galaxy s24' yalnizca Samsung gosterir", async () => {
    const outcome = await find("samsung galaxy s24");
    expect(outcome.items.length).toBeGreaterThan(0);
    for (const item of outcome.items) expect(item.brandName).toBe("Samsung");
  });

  it("esik/zero-result: alakasiz urun gosterilmez", async () => {
    for (const text of ["yoga matı", "buzdolabı", "playstation 5"]) {
      const outcome = await find(text);
      expect(outcome.mode, text).toBe("empty");
      expect(outcome.items, text).toEqual([]);
    }
  });

  // ---- Turkce ----------------------------------------------------------------------

  it("Turkce: kulaklik / KULAKLIK / es anlamli (headphone)", async () => {
    const lower = await find("kulaklık");
    const upper = await find("KULAKLIK");
    const ascii = await find("kulaklik");
    for (const outcome of [lower, upper, ascii]) {
      expect(outcome.mode).toBe("results");
      expect(titles(outcome)).toContain("Philips Kablosuz Kulaklık TA-200");
      expect(titles(outcome)).toContain("Sony Bluetooth Headphone WH-100");
    }
    expect(titles(upper)).toEqual(titles(lower));
    expect(titles(ascii)).toEqual(titles(lower));
  });

  it("Turkce: 'kosu ayakkabisi' = 'koşu ayakkabısı', noktalama/bosluk farki", async () => {
    const a = await find("koşu ayakkabısı");
    const b = await find("kosu ayakkabisi");
    const c = await find("  Koşu,   AYAKKABISI! ");
    expect(a.mode).toBe("results");
    // Fixture'in uc kosu ayakkabisi eksiksiz gelir; tohum katalogundaki ayni
    // kelimeli urunler (or. "Vira Kosu Ayakkabisi") bu sayimi bozmaz.
    expect(fixtureTitles(a).sort()).toEqual([
      "Adidas Duramo Koşu Ayakkabısı",
      "Nike Pegasus Koşu Ayakkabısı",
      "Nike Revolution Koşu Ayakkabısı",
    ]);
    expect(titles(b).sort()).toEqual(titles(a).sort());
    expect(titles(c).sort()).toEqual(titles(a).sort());
  });

  it("marka + model numarasi: 'apple iphone 17 128gb' ve 'iPhone17' bosluksuz degil", async () => {
    const outcome = await find("apple iphone 17 128 gb");
    expect(outcome.mode).toBe("results");
    expect(titles(outcome)[0]).toBe("Apple iPhone 17 128GB");
  });

  // ---- maliyet / gecikme --------------------------------------------------------------

  it("DB sorgu sayisi: exact erken cikar, zero-result sinirli", async () => {
    const report: Record<string, { queries: number; ms: number; stages: number }> = {};
    for (const text of [
      "nike koşu ayakkabısı",
      "iphone 17 pro",
      "iphone 17 pro max",
      "mavi nike koşu ayakkabısı",
      "yoga matı",
    ]) {
      meter.reset();
      const started = performance.now();
      const outcome = await find(text);
      report[text] = {
        queries: meter.count(),
        ms: Math.round(performance.now() - started),
        stages: outcome.trace.stagesTried.length,
      };
    }
    console.info("[fallback-cost]", JSON.stringify(report));
    // exact sonuc: ilk adimda durur (arama + starting-from = 2 sorgu).
    expect(report["nike koşu ayakkabısı"]?.queries).toBe(2);
    expect(report["iphone 17 pro"]?.queries).toBeLessThanOrEqual(2);
    // zero-result: en kotu durum sinirli (<=10 adim x (arama + starting-from + fuzzy set_config)).
    for (const entry of Object.values(report)) expect(entry.queries).toBeLessThanOrEqual(30);
  });
});
