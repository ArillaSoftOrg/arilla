import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getPublicTrends, getTrendBySlug, listSitemapTrends } from "./get-trends.ts";

/**
 * Sitemap'e girecek trendler (docs/sitemap.md, karar 0158): `/trendler` ile ayni gorunurluk
 * (yayinda + 4 gosterilebilir urun). Yayin penceresi bakilmaz (karar 0077: editoryal
 * tahmin, erisim siniri degil). Gercek Postgres.
 */
const PREFIX = "test-sitemap-trend";
const NOW = new Date("2026-10-30T12:00:00Z");

describe("listSitemapTrends - integration (real Postgres)", () => {
  let db: Database;

  async function cleanup(): Promise<void> {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM trend WHERE slug LIKE $1", [`${PREFIX}%`]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`${PREFIX}%`]);
    });
  }

  async function sitemapSlugs(): Promise<string[]> {
    return (await listSitemapTrends(db))
      .map((row) => row.slug)
      .filter((slug) => slug.startsWith(PREFIX));
  }

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
    await withOwnerClient(async (client) => {
      async function product(key: string, opts: { image: boolean; inStock: boolean }) {
        const row = await client.query(
          `INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count, offer_count)
           VALUES ($1, $2, $3, 10000, $4, 1) RETURNING id`,
          [
            `${PREFIX}-${key}`,
            `Ürün ${key}`,
            opts.image ? `https://img.test.example/${PREFIX}/${key}.jpg` : null,
            opts.inStock ? 1 : 0,
          ],
        );
        return Number(row.rows[0].id);
      }
      const showable = [];
      for (let i = 0; i < 4; i++)
        showable.push(await product(`p${i}`, { image: true, inStock: true }));
      const soldOut = await product("tukendi", { image: true, inStock: false });
      const noImage = await product("gorselsiz", { image: false, inStock: true });

      async function trend(
        key: string,
        opts: { status?: string; type?: string; from?: string | null; until?: string | null },
        members: number[],
      ) {
        const row = await client.query(
          `INSERT INTO trend (slug, title, description, category, status, trend_type, active_from, active_until)
           VALUES ($1, $2, 'Açıklama.', 'moda', $3, $4, $5, $6) RETURNING id`,
          [
            `${PREFIX}-${key}`,
            `Trend ${key}`,
            opts.status ?? "published",
            opts.type ?? "evergreen",
            opts.from ?? null,
            opts.until ?? null,
          ],
        );
        const id = Number(row.rows[0].id);
        for (const [order, productId] of members.entries()) {
          await client.query(
            "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1, $2, $3)",
            [id, productId, order],
          );
        }
      }

      const all = [...showable, soldOut, noImage];
      await trend("evergreen", {}, all);
      await trend(
        "pencere-ici",
        { type: "seasonal", from: "2026-10-01", until: "2026-12-01" },
        all,
      );
      await trend(
        "pencere-oncesi",
        { type: "campaign", from: "2026-11-15", until: "2026-12-01" },
        all,
      );
      await trend(
        "pencere-sonrasi",
        { type: "seasonal", from: "2026-06-01", until: "2026-09-01" },
        all,
      );
      await trend("taslak", { status: "draft" }, all);
      await trend("arsiv", { status: "archived" }, all);
      // 3 gosterilebilir + stok disi + gorselsiz: toplam 5 bag ama esik (4) alti.
      await trend("esik-alti", {}, [...showable.slice(0, 3), soldOut, noImage]);
    });
  });

  afterAll(cleanup);

  it("gorunur trendlerin hepsi, sort_order/id sirasinda; yayin penceresi bakilmaz", async () => {
    expect(await sitemapSlugs()).toEqual([
      `${PREFIX}-evergreen`,
      `${PREFIX}-pencere-ici`,
      `${PREFIX}-pencere-oncesi`,
      `${PREFIX}-pencere-sonrasi`,
    ]);
  });

  it("harita /trendler listesiyle ayni kumedir (tek gorunurluk kurali)", async () => {
    const listed = (await getPublicTrends(db, NOW))
      .map((trend) => trend.slug)
      .filter((slug) => slug.startsWith(PREFIX));
    expect(await sitemapSlugs()).toEqual(listed);
  });

  it("taslak, arsiv ve esik alti (stok disi / gorselsiz urun sayilmaz) haritaya girmez, detay 404", async () => {
    const slugs = await sitemapSlugs();
    for (const key of ["taslak", "arsiv", "esik-alti"]) {
      expect(slugs).not.toContain(`${PREFIX}-${key}`);
      expect(await getTrendBySlug(db, `${PREFIX}-${key}`, NOW)).toBeNull();
    }
  });

  it("pencere disi mevsimlik/kampanya trendinin detayi acilir (pencere erisim siniri degil)", async () => {
    for (const key of ["pencere-oncesi", "pencere-sonrasi"]) {
      expect(await getTrendBySlug(db, `${PREFIX}-${key}`, NOW), key).not.toBeNull();
    }
  });

  it("yayindan kaldirilan trend bir sonraki okumada haritadan cikar (onbellek yok)", async () => {
    expect(await sitemapSlugs()).toContain(`${PREFIX}-evergreen`);
    await withOwnerClient((client) =>
      client.query("UPDATE trend SET status = 'archived' WHERE slug = $1", [`${PREFIX}-evergreen`]),
    );
    expect(await sitemapSlugs()).not.toContain(`${PREFIX}-evergreen`);
  });
});
