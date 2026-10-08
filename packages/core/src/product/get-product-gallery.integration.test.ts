import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getProductGallery } from "./get-product-gallery.ts";

const DOMAIN_A = "test-gallery-a.example";
const DOMAIN_B = "test-gallery-b.example";
const SLUG = "test-gallery-product";

interface Fixture {
  productId: number;
  offerA: number;
  offerB: number;
}

type Img = [name: string, rank: number | null, status?: string, r2?: string];

describe("getProductGallery() - integration (real Postgres)", () => {
  let db: Database;
  let fx: Fixture;

  async function setImages(offerId: number, images: Img[]): Promise<void> {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM offer_image WHERE offer_id = $1", [offerId]);
      for (const [index, [name, rank, status, r2]] of images.entries()) {
        await c.query(
          `INSERT INTO offer_image (offer_id, url_hash, source_url, r2_url, source_position, display_rank, status)
           VALUES ($1, decode(md5($2), 'hex'), $3, $4, $5, $6, $7)`,
          [
            offerId,
            `${offerId}-${name}`,
            `https://cdn.example/${name}.jpg`,
            r2 ?? null,
            index,
            rank,
            status ?? "active",
          ],
        );
      }
    });
  }

  async function cleanup(): Promise<void> {
    await withOwnerClient(async (c) => {
      await c.query(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = ANY($1))",
        [[DOMAIN_A, DOMAIN_B]],
      );
      await c.query("DELETE FROM product WHERE slug = $1", [SLUG]);
      await c.query("DELETE FROM merchant WHERE domain = ANY($1)", [[DOMAIN_A, DOMAIN_B]]);
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
    fx = await withOwnerClient(async (c) => {
      const merchant = async (slug: string, domain: string) =>
        Number(
          (
            await c.query(
              "INSERT INTO merchant (slug, name, domain, source_type) VALUES ($1, 'T', $2, 'shopify') RETURNING id",
              [slug, domain],
            )
          ).rows[0].id,
        );
      const mA = await merchant("test-gallery-a", DOMAIN_A);
      const mB = await merchant("test-gallery-b", DOMAIN_B);
      const productId = Number(
        (
          await c.query(
            "INSERT INTO product (slug, title, primary_image_url) VALUES ($1, 'Galeri', 'https://cdn.example/a0.jpg') RETURNING id",
            [SLUG],
          )
        ).rows[0].id,
      );
      const offer = async (merchantId: number, ext: string, image: string, price: number) =>
        Number(
          (
            await c.query(
              `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, image_url, current_price, currency, in_stock)
               VALUES ($1, $2, $3, 'https://x.example/p', 'T', $4, $5, 'TRY', true) RETURNING id`,
              [merchantId, productId, ext, image, price],
            )
          ).rows[0].id,
        );
      // A: urunun eski gorselinin geldigi offer (pahali). B: daha ucuz, farkli gorsel.
      const offerA = await offer(mA, "a", "https://cdn.example/a0.jpg", 20000);
      const offerB = await offer(mB, "b", "https://cdn.example/b0.jpg", 10000);
      return { productId, offerA, offerB };
    });
  });

  afterAll(cleanup);

  it("falls back to legacy primary_image_url when there are no gallery rows", async () => {
    await setImages(fx.offerA, []);
    await setImages(fx.offerB, []);
    const gallery = await getProductGallery(db, fx.productId, "https://cdn.example/a0.jpg");
    expect(gallery.source).toBe("legacy");
    expect(gallery.images).toHaveLength(1);
  });

  it("returns none when there is nothing at all", async () => {
    const gallery = await getProductGallery(db, fx.productId, null);
    expect(gallery).toEqual({ images: [], source: "none" });
  });

  it("returns only display-ranked images, in rank order, max 3, with provenance", async () => {
    await setImages(fx.offerA, [
      ["a0", 0],
      ["a1", 2],
      ["a2", 1],
      ["a3", null],
      ["a4", null],
      ["a5", null],
    ]);
    const gallery = await getProductGallery(db, fx.productId, "https://cdn.example/a0.jpg");
    expect(gallery.source).toBe("gallery");
    expect(gallery.images.map((i) => i.url.slice(-6))).toEqual(["a0.jpg", "a2.jpg", "a1.jpg"]);
    expect(gallery.images.every((i) => i.sourceOfferId === fx.offerA)).toBe(true);
  });

  it("starts from the offer that supplied the legacy primary image, not the cheapest", async () => {
    await setImages(fx.offerB, [["b0", 0]]);
    const gallery = await getProductGallery(db, fx.productId, "https://cdn.example/a0.jpg");
    expect(gallery.images[0]?.sourceOfferId).toBe(fx.offerA);
  });

  it("uses another offer when the origin offer has nothing to display", async () => {
    await setImages(fx.offerA, [["a0", null, "removed"]]);
    const gallery = await getProductGallery(db, fx.productId, "https://cdn.example/a0.jpg");
    expect(gallery.images.map((i) => i.sourceOfferId)).toEqual([fx.offerB]);
  });

  it("removed and broken images are never displayed", async () => {
    await setImages(fx.offerA, [
      ["a0", null, "removed"],
      ["a1", null, "broken"],
    ]);
    await setImages(fx.offerB, []);
    const gallery = await getProductGallery(db, fx.productId, "https://cdn.example/a0.jpg");
    expect(gallery.source).toBe("legacy");
  });

  it("prefers r2_url over source_url", async () => {
    await setImages(fx.offerA, [
      ["a0", 0, "active", "https://media.manicepte.com/products/a0.webp"],
    ]);
    const gallery = await getProductGallery(db, fx.productId, "https://cdn.example/a0.jpg");
    expect(gallery.images[0]?.url).toBe("https://media.manicepte.com/products/a0.webp");
  });

  it("application role can read and write offer_image but gets no extra table rights", async () => {
    await withOwnerClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL ROLE arilla_app");
        await c.query("SELECT 1 FROM offer_image LIMIT 1");
        await c.query(
          `INSERT INTO offer_image (offer_id, url_hash, source_url, source_position)
           VALUES ($1, decode(md5('role-test'), 'hex'), 'https://cdn.example/role.jpg', 5)`,
          [fx.offerA],
        );
        await c.query("UPDATE offer_image SET width = 10 WHERE offer_id = $1", [fx.offerA]);
      } finally {
        await c.query("ROLLBACK");
      }
    });
  });
});
