/**
 * Paylaşım önizlemesi - gerçek `generateMetadata` (ürün ve trend), gerçek yerel
 * Postgres; `next/*` taklit edilir. Uzak adres görülürse durur.
 *
 * - Ürün kapısı kapalıyken meta veri üretilmez (anonim → landing).
 * - Yayınlanmamış ürün ve yayınlanmamış/eşik altı trend hiçbir alan sızdırmaz.
 * - Yayındaki ürün/trend gerçek görseliyle, görselsiz olan site ikonuyla önizlenir.
 */
import { createDatabase } from "@arilla/db";
import type { Metadata } from "next";
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

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  permanentRedirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error("notFound");
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

const PREFIX = `paylas-${Date.now()}`;
const IMAGE = "https://cdn.paylas.example/urun.jpg";
const HERO = "https://cdn.paylas.example/kapak.jpg";
const productIds: number[] = [];
const trendIds: number[] = [];
let merchantId = 0;

async function productMeta(slug: string): Promise<Metadata> {
  const { generateMetadata } = await import("./urun/[slug]/page.tsx");
  return generateMetadata({ params: Promise.resolve({ slug }) });
}

async function trendMeta(slug: string): Promise<Metadata> {
  const { generateMetadata } = await import("./trendler/[slug]/page.tsx");
  return generateMetadata({ params: Promise.resolve({ slug }) });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    // Yayınlanmamış ürün yalnızca kaynak ilanı olabilir (`product_unpublished_is_source_listing`).
    const merchant = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, is_active)
       VALUES ($1, 'Paylaşım mağazası', $2, 'xml_feed', TRUE) RETURNING id`,
      [PREFIX, `${PREFIX}.example`],
    );
    merchantId = Number(merchant.rows[0].id);
    async function product(key: string, image: string | null, state = "published") {
      const source = state === "published" ? [null, null] : [merchantId, `${PREFIX}-${key}`];
      const row = await client.query(
        `INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count,
                              offer_count, publication_state, source_merchant_id, source_external_id)
         VALUES ($1, $2, $3, 10000, 1, 2, $4, $5, $6) RETURNING id`,
        [`${PREFIX}-${key}`, `Paylaşım ürünü ${key}`, image, state, ...source],
      );
      const id = Number(row.rows[0].id);
      productIds.push(id);
      return id;
    }
    async function trend(key: string, status: string, hero: string | null, members: number[]) {
      const row = await client.query(
        `INSERT INTO trend (slug, title, description, category, status, hero_image_url)
         VALUES ($1, $2, $3, 'moda', $4, $5) RETURNING id`,
        [`${PREFIX}-${key}`, `Paylaşım trendi ${key}`, `Açıklama ${key}.`, status, hero],
      );
      const id = Number(row.rows[0].id);
      trendIds.push(id);
      for (const [order, productId] of members.entries()) {
        await client.query(
          "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1, $2, $3)",
          [id, productId, order],
        );
      }
    }

    await product("gorselli", IMAGE);
    await product("gorselsiz", null);
    await product("http", "http://cdn.paylas.example/guvensiz.jpg");
    await product("taslak", IMAGE, "draft");
    const members = [
      await product("t1", IMAGE),
      await product("t2", IMAGE),
      await product("t3", IMAGE),
      await product("t4", IMAGE),
    ];
    await trend("yayinda", "published", HERO, members);
    await trend("kapaksiz", "published", null, members);
    await trend("taslak", "draft", HERO, members);
    await trend("az", "published", HERO, members.slice(0, 2));
  });
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "open");
  vi.stubEnv("APP_URL", "http://localhost:3000");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await owner(async (client) => {
    await client.query("DELETE FROM trend_product WHERE trend_id = ANY($1)", [trendIds]);
    await client.query("DELETE FROM trend WHERE id = ANY($1)", [trendIds]);
    await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
  });
  await ownerPool?.end();
});

describe("ürün kapısı kapalıyken", () => {
  it.each([
    ["ürün", () => productMeta(`${PREFIX}-gorselli`)],
    ["trend", () => trendMeta(`${PREFIX}-yayinda`)],
  ])("%s meta verisi üretilmez; anonim landing'e yönlenir", async (_name, call) => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    await expect(call()).rejects.toMatchObject({ to: "/" });
  });
});

describe("ürün önizlemesi", () => {
  it("gerçek görsel, başlık, açıklama ve kanonik adres", async () => {
    const meta = await productMeta(`${PREFIX}-gorselli`);
    expect(meta.title).toBe(`Paylaşım ürünü gorselli fiyat karşılaştırma`);
    expect(meta.alternates).toEqual({ canonical: `/urun/${PREFIX}-gorselli` });
    expect(meta.openGraph).toMatchObject({
      siteName: "ManiCepte",
      title: meta.title,
      description: meta.description,
      url: `/urun/${PREFIX}-gorselli`,
      images: [{ url: IMAGE, alt: "Paylaşım ürünü gorselli" }],
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it.each(["gorselsiz", "http"])("%s ürün site ikonuna düşer, küçük kart", async (key) => {
    const meta = await productMeta(`${PREFIX}-${key}`);
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: "/icon4.png" })]);
    expect(meta.twitter).toMatchObject({ card: "summary" });
  });

  it("yayınlanmamış ürün hiçbir alan sızdırmaz", async () => {
    expect(await productMeta(`${PREFIX}-taslak`)).toEqual({});
  });
});

describe("trend önizlemesi", () => {
  it("yayındaki koleksiyon kendi kapağıyla", async () => {
    const meta = await trendMeta(`${PREFIX}-yayinda`);
    expect(meta.alternates).toEqual({ canonical: `/trendler/${PREFIX}-yayinda` });
    expect(meta.openGraph).toMatchObject({
      title: "Paylaşım trendi yayinda",
      description: "Açıklama yayinda.",
      images: [{ url: HERO, alt: "Paylaşım trendi yayinda" }],
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("kapaksız koleksiyon sayfanın gösterdiği temsilci ürün görselini kullanır", async () => {
    const meta = await trendMeta(`${PREFIX}-kapaksiz`);
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: IMAGE })]);
  });

  it.each(["taslak", "az"])("%s koleksiyon hiçbir alan sızdırmaz", async (key) => {
    expect(await trendMeta(`${PREFIX}-${key}`)).toEqual({});
  });
});
