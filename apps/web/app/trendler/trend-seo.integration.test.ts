/**
 * Trend SEO (karar 0158) - gerçek yerel Postgres, gerçek sayfa/rota kodu; `next/*` taklit.
 *
 * - `/sitemap-sayfalar.xml`: `/trendler`deki görünür trendlerin hepsi; kapalı üründe hiç trend yok.
 * - Yayın penceresi indekslemeyi etkilemez: pencere dışı mevsimlik trend haritada, `noindex` yok.
 * - Harita adresi = sayfanın kanonik adresi; `robots.txt` kuralı ürün kapısını izler.
 * - JSON-LD: ızgaradaki ürünlerle aynı sıra/ad/adres; fiyat ve marka yok.
 * - G1 paylaşım metadata'sı (og/twitter) bozulmaz.
 */
import { createDatabase } from "@arilla/db";
import type { Metadata } from "next";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {
  constructor() {
    super("notFound");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;
async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

const SITE = "http://localhost:3000";
const PREFIX = "test-trend-seo";
const slug = (key: string) => `${PREFIX}-${key}`;

async function cleanup(): Promise<void> {
  await owner(async (client) => {
    await client.query("DELETE FROM trend WHERE slug LIKE $1", [`${PREFIX}%`]);
    await client.query("DELETE FROM product WHERE slug LIKE $1", [`${PREFIX}%`]);
  });
}

async function sitemapLocs(): Promise<string[]> {
  const { GET } = await import("../sitemap-sayfalar.xml/route.ts");
  const response = await GET();
  expect(response.status).toBe(200);
  const xml = await response.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
}

const trendLocs = async () => (await sitemapLocs()).filter((loc) => loc.includes(`/${PREFIX}-`));

async function meta(key: string): Promise<Metadata> {
  const { generateMetadata } = await import("./[slug]/page.tsx");
  return generateMetadata({ params: Promise.resolve({ slug: slug(key) }) });
}

async function render(key: string): Promise<string> {
  const { default: Page } = await import("./[slug]/page.tsx");
  const element = (await Page({ params: Promise.resolve({ slug: slug(key) }) })) as ReactElement;
  return renderToStaticMarkup(element);
}

function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1] ?? "null") as Record<string, unknown>,
  );
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await cleanup();
  await owner(async (client) => {
    async function product(key: string, opts: { image?: boolean; inStock?: boolean } = {}) {
      const row = await client.query(
        `INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count, offer_count)
         VALUES ($1, $2, $3, 25000, $4, 2) RETURNING id`,
        [
          slug(key),
          `SEO ürünü ${key}`,
          opts.image === false ? null : `https://img.test.example/${PREFIX}/${key}.jpg`,
          opts.inStock === false ? 0 : 1,
        ],
      );
      return Number(row.rows[0].id);
    }
    // Sıra kasten id sırasının tersi: JSON-LD `sort_order`ı izlemeli.
    const shown = [
      await product("p0"),
      await product("p1"),
      await product("p2"),
      await product("p3"),
    ];
    const soldOut = await product("tukendi", { inStock: false });
    const noImage = await product("gorselsiz", { image: false });
    const members = [shown[3], soldOut, shown[1], noImage, shown[0], shown[2]] as number[];

    async function trend(
      key: string,
      opts: { status?: string; type?: string; from?: string; until?: string; sort?: number },
      ids: number[],
    ) {
      const row = await client.query(
        `INSERT INTO trend (slug, title, description, category, status, trend_type,
                            active_from, active_until, sort_order)
         VALUES ($1, $2, 'Açıklama.', 'moda', $3, $4, $5, $6, $7) RETURNING id`,
        [
          slug(key),
          `SEO trendi ${key}`,
          opts.status ?? "published",
          opts.type ?? "evergreen",
          opts.from ?? null,
          opts.until ?? null,
          opts.sort ?? 0,
        ],
      );
      for (const [order, productId] of ids.entries()) {
        await client.query(
          "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1, $2, $3)",
          [Number(row.rows[0].id), productId, order],
        );
      }
    }
    await trend("yayinda", { sort: 1 }, members);
    await trend(
      "pencere-ici",
      { type: "seasonal", from: "2000-01-01", until: "2999-01-01", sort: 2 },
      members,
    );
    await trend(
      "pencere-sonrasi",
      { type: "seasonal", from: "2000-01-01", until: "2001-01-01", sort: 3 },
      members,
    );
    await trend(
      "pencere-oncesi",
      { type: "campaign", from: "2998-01-01", until: "2999-01-01", sort: 4 },
      members,
    );
    await trend("taslak", { status: "draft" }, members);
    await trend("arsiv", { status: "archived" }, members);
    await trend("esik-alti", {}, [shown[0], shown[1], shown[2], soldOut, noImage] as number[]);
  });
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "open");
  vi.stubEnv("APP_URL", SITE);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await ownerPool?.end();
});

describe("sitemap", () => {
  it("görünür trendlerin hepsi, sırasıyla; yayın penceresi dışındakiler dahil", async () => {
    expect(await trendLocs()).toEqual([
      `${SITE}/trendler/${slug("yayinda")}`,
      `${SITE}/trendler/${slug("pencere-ici")}`,
      `${SITE}/trendler/${slug("pencere-sonrasi")}`,
      `${SITE}/trendler/${slug("pencere-oncesi")}`,
    ]);
  });

  it("taslak, arşiv ve eşik altı trend haritada yok", async () => {
    const locs = await trendLocs();
    for (const key of ["taslak", "arsiv", "esik-alti"]) {
      expect(locs).not.toContain(`${SITE}/trendler/${slug(key)}`);
    }
  });

  it("statik sayfalar ve ürün liste sayfaları yerinde (regresyon)", async () => {
    const locs = await sitemapLocs();
    for (const path of ["/", "/sss", "/blog", "/kesfet", "/firsatlar", "/trendler"]) {
      expect(locs).toContain(`${SITE}${path}`);
    }
  });

  it("ürün kapalıyken hiçbir trend (ve ürün sayfası) haritaya girmez", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const locs = await sitemapLocs();
    expect(locs.some((loc) => loc.includes("/trendler"))).toBe(false);
    expect(locs).toContain(`${SITE}/`);
  });

  it("harita adresi sayfanın kanonik adresiyle birebir aynı", async () => {
    for (const loc of await trendLocs()) {
      const key = loc.split(`/${PREFIX}-`)[1] ?? "";
      const canonical = (await meta(key)).alternates?.canonical;
      expect(new URL(String(canonical), SITE).toString()).toBe(loc);
    }
  });

  it("yayından kaldırılan trend bir sonraki istekte haritadan çıkar", async () => {
    await owner((client) =>
      client.query("UPDATE trend SET status = 'archived' WHERE slug = $1", [slug("pencere-ici")]),
    );
    try {
      expect(await trendLocs()).not.toContain(`${SITE}/trendler/${slug("pencere-ici")}`);
      await expect(render("pencere-ici")).rejects.toBeInstanceOf(NotFoundSignal);
    } finally {
      await owner((client) =>
        client.query("UPDATE trend SET status = 'published' WHERE slug = $1", [
          slug("pencere-ici"),
        ]),
      );
    }
  });
});

describe("sayfa ve metadata", () => {
  it("görünür trend indekslenir (robots yok); og/twitter (G1) korunur", async () => {
    const m = await meta("yayinda");
    expect(m.robots).toBeUndefined();
    expect(m.openGraph).toMatchObject({ title: "SEO trendi yayinda", siteName: "ManiCepte" });
    expect(m.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it.each(["pencere-sonrasi", "pencere-oncesi"])(
    "%s: sayfa açılır, noindex almaz, JSON-LD üretilir",
    async (key) => {
      const m = await meta(key);
      expect(m.robots).toBeUndefined();
      expect(m.alternates).toEqual({ canonical: `/trendler/${slug(key)}` });
      const html = await render(key);
      expect(html).toContain(`SEO trendi ${key}`);
      expect(jsonLd(html).map((item) => item["@type"])).toEqual(["BreadcrumbList", "ItemList"]);
    },
  );

  it.each(["taslak", "arsiv", "esik-alti"])("%s: metadata boş, sayfa 404", async (key) => {
    expect(await meta(key)).toEqual({});
    await expect(render(key)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("robots.txt: ürün açıkken trendler taranabilir, kapalıyken kapalı", async () => {
    const { default: robots } = await import("../robots.ts");
    const disallow = () => [robots().rules].flat().flatMap((rule) => [rule?.disallow ?? []].flat());
    expect(disallow()).not.toContain("/trendler");
    vi.stubEnv("PRODUCT_ACCESS", "");
    expect(disallow()).toContain("/trendler");
  });

  it("ürün kapalıyken JSON-LD dahil hiçbir şey üretilmez", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    await expect(render("yayinda")).rejects.toMatchObject({ to: "/" });
    await expect(meta("yayinda")).rejects.toMatchObject({ to: "/" });
  });
});

describe("JSON-LD", () => {
  it("ItemList ızgaradaki ürünlerle aynı sıra, ad ve adres; stok dışı/görselsiz yok", async () => {
    const html = await render("yayinda");
    const gridHrefs = [...html.matchAll(/href="(\/urun\/[^"]+)"/g)].map((m) => m[1]);
    const data = jsonLd(html);
    expect(data.map((item) => item["@type"])).toEqual(["BreadcrumbList", "ItemList"]);
    const list = data[1] as { numberOfItems: number; itemListElement: Record<string, unknown>[] };
    expect(list.itemListElement.map((item) => item.name)).toEqual([
      "SEO ürünü p3",
      "SEO ürünü p1",
      "SEO ürünü p0",
      "SEO ürünü p2",
    ]);
    expect(list.itemListElement.map((item) => new URL(String(item.url)).pathname)).toEqual(
      gridHrefs,
    );
    expect(list.itemListElement.map((item) => item.position)).toEqual([1, 2, 3, 4]);
    expect(list.numberOfItems).toBe(4);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/tukendi|gorselsiz|"price|"offers|"brand|"availability|Rating/);
  });

  it("BreadcrumbList son öğesi kanonik trend adresi", async () => {
    const [breadcrumb] = jsonLd(await render("yayinda"));
    const items = (breadcrumb as { itemListElement: { item: string }[] }).itemListElement;
    expect(items.map((item) => item.item)).toEqual([
      `${SITE}/`,
      `${SITE}/trendler`,
      `${SITE}/trendler/${slug("yayinda")}`,
    ]);
  });
});
