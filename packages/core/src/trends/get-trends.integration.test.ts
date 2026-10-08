import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getPublicTrends, getTrendBySlug } from "./get-trends.ts";
import { MIN_PUBLIC_TREND_PRODUCTS, TREND_THUMBNAIL_COUNT, TREND_THUMBNAIL_POOL } from "./types.ts";

const PREFIX = "test-trends-it";
const IMAGE = (n: number) => `https://img.test.example/${PREFIX}/${n}.jpg`;

describe("trends - integration (real Postgres)", () => {
  let db: Database;
  const ids = {
    trends: {} as Record<string, number>,
    products: [] as number[],
    soldOut: 0,
    noImage: 0,
  };

  async function cleanup(): Promise<void> {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM trend WHERE slug LIKE $1", [`${PREFIX}%`]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`${PREFIX}%`]);
      await client.query("DELETE FROM brand WHERE slug LIKE $1", [`${PREFIX}%`]);
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
    await withOwnerClient(async (client) => {
      const brand = await client.query(
        "INSERT INTO brand (slug, name, name_norm) VALUES ($1, 'Test Marka', 'testmarka') RETURNING id",
        [`${PREFIX}-brand`],
      );
      const brandId = Number(brand.rows[0].id);

      async function product(
        key: string,
        opts: { price: number | null; inStock: number; image: string | null; offers?: number },
      ): Promise<number> {
        const row = await client.query(
          `INSERT INTO product (slug, title, brand_id, primary_image_url, min_price, in_stock_count, offer_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            `${PREFIX}-${key}`,
            `Test ürün ${key}`,
            brandId,
            opts.image,
            opts.price,
            opts.inStock,
            opts.offers ?? 2,
          ],
        );
        return Number(row.rows[0].id);
      }

      // Fiyatlar kasten sirasiz: sort_order, fiyat sirasindan bagimsiz sinanir.
      const prices = [90_00, 30_00, 70_00, 50_00, 110_00, 20_00];
      for (let i = 0; i < prices.length; i++) {
        ids.products.push(
          await product(`p${i}`, { price: prices[i] ?? null, inStock: 1, image: IMAGE(i) }),
        );
      }
      ids.soldOut = await product("sold-out", { price: 10_00, inStock: 0, image: IMAGE(90) });
      ids.noImage = await product("no-image", { price: 10_00, inStock: 1, image: null });

      async function trend(
        key: string,
        opts: {
          status?: string;
          featured?: boolean;
          type?: string;
          hero?: string | null;
          from?: string | null;
          until?: string | null;
          order?: number;
        } = {},
      ): Promise<number> {
        const row = await client.query(
          `INSERT INTO trend (slug, title, description, category, status, featured, trend_type,
                              hero_image_url, active_from, active_until, sort_order)
           VALUES ($1, $2, $3, 'moda', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            `${PREFIX}-${key}`,
            `Test trend ${key}`,
            `Test açıklaması ${key}.`,
            opts.status ?? "published",
            opts.featured ?? false,
            opts.type ?? "evergreen",
            opts.hero ?? null,
            opts.from ?? null,
            opts.until ?? null,
            opts.order ?? 0,
          ],
        );
        return Number(row.rows[0].id);
      }

      async function link(trendId: number, productId: number, order: number): Promise<void> {
        await client.query(
          "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1, $2, $3)",
          [trendId, productId, order],
        );
      }

      // ok: 6 urun, sort_order id sirasinin TERSI; satis disi iki urun de bagli.
      ids.trends.ok = await trend("ok", { featured: true, order: 1 });
      const p = ids.products;
      const order = [p[5], p[4], p[3], p[2], p[1], p[0]] as number[];
      for (const [i, productId] of order.entries()) await link(ids.trends.ok, productId, i);
      await link(ids.trends.ok, ids.soldOut, 6);
      await link(ids.trends.ok, ids.noImage, 7);

      ids.trends.empty = await trend("empty", { order: 2 });
      ids.trends.few = await trend("few", { order: 3 });
      await link(ids.trends.few, p[0] as number, 0);
      await link(ids.trends.few, p[1] as number, 1);
      ids.trends.draft = await trend("draft", { status: "draft", order: 4 });
      for (const [i, productId] of p.slice(0, 5).entries()) {
        await link(ids.trends.draft, productId, i);
      }
      ids.trends.hero = await trend("hero", {
        hero: "https://cdn.test.example/hero.jpg",
        order: 5,
      });
      for (const [i, productId] of p.slice(0, 4).entries()) {
        await link(ids.trends.hero, productId, i);
      }
      ids.trends.window = await trend("window", {
        type: "seasonal",
        from: "2026-09-01T00:00:00Z",
        until: "2026-12-01T00:00:00Z",
        order: 6,
      });
      for (const [i, productId] of p.slice(0, 4).entries()) {
        await link(ids.trends.window, productId, i);
      }
    });
  });

  afterAll(cleanup);

  it("slug lookup: yayinlanmis trend bulunur, ayri slug null", async () => {
    const found = await getTrendBySlug(db, `${PREFIX}-ok`);
    expect(found?.trend.title).toBe("Test trend ok");
    expect(await getTrendBySlug(db, `${PREFIX}-yok`)).toBeNull();
  });

  it("trend-product siralamasi trend_product.sort_order'a gore (fiyata/id'ye degil)", async () => {
    const found = await getTrendBySlug(db, `${PREFIX}-ok`);
    expect(found?.products.map((item) => item.slug)).toEqual([
      `${PREFIX}-p5`,
      `${PREFIX}-p4`,
      `${PREFIX}-p3`,
      `${PREFIX}-p2`,
      `${PREFIX}-p1`,
      `${PREFIX}-p0`,
    ]);
  });

  it("stokta olmayan ve gorselsiz urun izgaraya girmez", async () => {
    const found = await getTrendBySlug(db, `${PREFIX}-ok`);
    const slugs = found?.products.map((item) => item.slug) ?? [];
    expect(slugs).not.toContain(`${PREFIX}-sold-out`);
    expect(slugs).not.toContain(`${PREFIX}-no-image`);
    expect(found?.trend.productCount).toBe(6);
  });

  it("bos, yetersiz ve taslak trend: detay null", async () => {
    expect(await getTrendBySlug(db, `${PREFIX}-empty`)).toBeNull();
    expect(await getTrendBySlug(db, `${PREFIX}-few`)).toBeNull();
    expect(await getTrendBySlug(db, `${PREFIX}-draft`)).toBeNull();
  });

  it("liste: yalniz yeterli urunlu yayinlanmis trendler, sort_order sirasinda, N+1 yok", async () => {
    const trends = await getPublicTrends(db, new Date("2026-10-08T00:00:00Z"));
    const mine = trends.filter((t) => t.slug.startsWith(PREFIX)).map((t) => t.slug);
    expect(mine).toEqual([`${PREFIX}-ok`, `${PREFIX}-hero`, `${PREFIX}-window`]);
  });

  it("liste ozeti: sayi, baslangic fiyati ve onizleme gorselleri", async () => {
    const trends = await getPublicTrends(db);
    const ok = trends.find((t) => t.slug === `${PREFIX}-ok`);
    expect(ok?.productCount).toBe(6);
    expect(ok?.startingPrice).toBe(20_00); // en dusuk gosterilebilir fiyat; sold-out 10_00 sayilmaz
    // Havuz: gorunenden (4) fazla aday; 'ok' trendinin 6 gosterilebilir urunu var.
    expect(ok?.thumbnails).toHaveLength(Math.min(6, TREND_THUMBNAIL_POOL));
    expect(TREND_THUMBNAIL_POOL).toBeGreaterThan(TREND_THUMBNAIL_COUNT);
    expect(ok?.thumbnails[0]?.imageUrl).toBe(IMAGE(5)); // sort_order 0 = p5
    expect(ok?.featured).toBe(true);
    expect(ok?.productCount).toBeGreaterThanOrEqual(MIN_PUBLIC_TREND_PRODUCTS);
  });

  it("kapak sirasi: trend gorseli -> temsilci urun gorseli", async () => {
    const trends = await getPublicTrends(db);
    const withHero = trends.find((t) => t.slug === `${PREFIX}-hero`);
    const without = trends.find((t) => t.slug === `${PREFIX}-ok`);
    expect(withHero?.heroSource).toBe("trend");
    expect(withHero?.heroImageUrl).toBe("https://cdn.test.example/hero.jpg");
    expect(without?.heroSource).toBe("product");
    expect(without?.heroImageUrl).toBe(IMAGE(5));
    const detail = await getTrendBySlug(db, `${PREFIX}-ok`);
    expect(detail?.trend.heroImageUrl).toBe(IMAGE(5));
    // Kirik gorsel yedegi: trend gorseli ilk aday, ardindan urun gorselleri (tekrarsiz, sirali).
    expect(withHero?.heroCandidates).toEqual([
      "https://cdn.test.example/hero.jpg",
      IMAGE(0),
      IMAGE(1),
      IMAGE(2),
      IMAGE(3),
    ]);
    expect(without?.heroCandidates).toEqual([IMAGE(5), IMAGE(4), IMAGE(3), IMAGE(2)]);
    expect(detail?.trend.heroCandidates[0]).toBe(IMAGE(5));
  });

  it("'su an' yalniz mevsimlik/kampanya ve pencere icindeyken", async () => {
    const inside = await getPublicTrends(db, new Date("2026-10-08T00:00:00Z"));
    const outside = await getPublicTrends(db, new Date("2027-03-01T00:00:00Z"));
    expect(inside.find((t) => t.slug === `${PREFIX}-window`)?.activeNow).toBe(true);
    expect(outside.find((t) => t.slug === `${PREFIX}-window`)?.activeNow).toBe(false);
    expect(inside.find((t) => t.slug === `${PREFIX}-ok`)?.activeNow).toBe(false);
  });
});

describe("trend semasi - kisitlar (real Postgres)", () => {
  async function expectViolation(sql: string, params: unknown[], code: string): Promise<void> {
    await withOwnerClient(async (client) => {
      await expect(client.query(sql, params)).rejects.toMatchObject({ code });
    });
  }

  const insertTrend = `INSERT INTO trend (slug, title, description, category) VALUES ($1, 't', 'd', $2)`;

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM trend WHERE slug LIKE 'test-trends-schema%'");
      await client.query("DELETE FROM product WHERE slug LIKE 'test-trends-schema%'");
    });
  });

  it("slug UNIQUE ve bicim CHECK", async () => {
    await withOwnerClient((client) => client.query(insertTrend, ["test-trends-schema-a", "moda"]));
    await expectViolation(insertTrend, ["test-trends-schema-a", "moda"], "23505");
    await expectViolation(insertTrend, ["Test_Trends", "moda"], "23514");
    await expectViolation(insertTrend, ["test-trends-schema-b", "bilinmeyen"], "23514");
  });

  it("status/trend_type/hero url ve pencere CHECK'leri", async () => {
    const base = (extra: string) =>
      `INSERT INTO trend (slug, title, description, category, ${extra})`;
    await expectViolation(
      `${base("status")} VALUES ('test-trends-schema-c', 't', 'd', 'moda', 'yok')`,
      [],
      "23514",
    );
    await expectViolation(
      `${base("trend_type")} VALUES ('test-trends-schema-d', 't', 'd', 'moda', 'yok')`,
      [],
      "23514",
    );
    await expectViolation(
      `${base("hero_image_url")} VALUES ('test-trends-schema-e', 't', 'd', 'moda', 'http://x.test/a.jpg')`,
      [],
      "23514",
    );
    await expectViolation(
      `${base("active_from, active_until")} VALUES ('test-trends-schema-f', 't', 'd', 'moda', now(), now() - interval '1 day')`,
      [],
      "23514",
    );
  });

  it("trend_product: FK, tekrar eden urun ve ayni siraya iki urun reddedilir; CASCADE", async () => {
    await withOwnerClient(async (client) => {
      const t = await client.query(
        `INSERT INTO trend (slug, title, description, category) VALUES ('test-trends-schema-g', 't', 'd', 'moda') RETURNING id`,
      );
      const trendId = Number(t.rows[0].id);
      const p1 = await client.query(
        `INSERT INTO product (slug, title) VALUES ('test-trends-schema-p1', 'a') RETURNING id`,
      );
      const p2 = await client.query(
        `INSERT INTO product (slug, title) VALUES ('test-trends-schema-p2', 'b') RETURNING id`,
      );
      const [a, b] = [Number(p1.rows[0].id), Number(p2.rows[0].id)];
      const ins = "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1,$2,$3)";

      await expect(client.query(ins, [trendId, 999_999_999, 0])).rejects.toMatchObject({
        code: "23503",
      });
      await client.query(ins, [trendId, a, 0]);
      await expect(client.query(ins, [trendId, a, 1])).rejects.toMatchObject({ code: "23505" });

      // UNIQUE (trend_id, sort_order) ERTELENMIS: COMMIT'te patlar.
      await client.query("BEGIN");
      await client.query(ins, [trendId, b, 0]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK").catch(() => undefined);

      // Ayni islemde yer degistirmek serbest (deferred).
      await client.query(ins, [trendId, b, 1]);
      await client.query("BEGIN");
      await client.query("UPDATE trend_product SET sort_order = 5 WHERE product_id = $1", [a]);
      await client.query("UPDATE trend_product SET sort_order = 0 WHERE product_id = $1", [b]);
      await client.query("COMMIT");

      await client.query("DELETE FROM trend WHERE id = $1", [trendId]);
      const left = await client.query("SELECT 1 FROM trend_product WHERE trend_id = $1", [trendId]);
      expect(left.rowCount).toBe(0);
    });
  });

  it("50 trend tohumu yerinde: benzersiz slug, hepsi yayinlanmis, aciklamalar dolu", async () => {
    await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n, count(DISTINCT slug)::int AS slugs,
                count(*) FILTER (WHERE status = 'published')::int AS published,
                count(*) FILTER (WHERE char_length(description) > 0)::int AS described
           FROM trend WHERE slug NOT LIKE 'test-trends%'`,
      );
      expect(res.rows[0]).toMatchObject({ n: 50, slugs: 50, published: 50, described: 50 });
    });
  });
});
