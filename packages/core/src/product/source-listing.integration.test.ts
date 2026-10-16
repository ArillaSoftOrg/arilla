/**
 * Kaynak ilanından ürün: yayın durumu görünürlüğü ve yurt dışı fiyat (karar 0121).
 * Gerçek PostgreSQL. Taslak/bekleyen ürün hiçbir herkese açık yüzeyde görünmez; yayınlanmış
 * USD ürün TL özetini kirletmez, kendi para birimi ve fiyat zamanıyla gösterilir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { searchProducts } from "../admin/catalog.ts";
import { CATALOG_QUALITY_CHECKS } from "../admin/catalog-quality.ts";
import { getProductForeignOffers } from "../offers/product-foreign-offers.ts";
import { compareMerchants } from "../search/compare-merchants.ts";
import { search } from "../search/search.ts";
import type { QueryObject } from "../search/types.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { findCatalogImageCandidates } from "../web-search/catalog.ts";
import { getColorVariants } from "./get-color-variants.ts";
import { refreshProductAggregates } from "./refresh-aggregates.ts";
import { resolveProductSlug } from "./resolve-product-slug.ts";
import { listSitemapEligibleProducts } from "./sitemap-eligibility.ts";

const suffix = Date.now();
const TAG = `kaynakzq${suffix.toString(36).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)] ?? "")}`;
const MODEL = `model-${suffix}`;
/** 15 haneli kaynak ilan kimliği (yönetim aramasında kimlik biçimi). */
const sourceIdOf = (key: string) => `9${suffix}${key.length}`;

function textQuery(text: string): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text,
    filters: {},
    style_tags: [],
    sort: "balanced",
    unparsed: text,
    confidence: 1,
  };
}

describe("kaynak ilanı ürünleri - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  let merchantId = 0;
  let categoryId = 0;
  const p: Record<"published" | "draft" | "held" | "usd", { id: number; slug: string }> = {
    published: { id: 0, slug: `${TAG}-yayinda` },
    draft: { id: 0, slug: `${TAG}-taslak` },
    held: { id: 0, slug: `${TAG}-beklemede` },
    usd: { id: 0, slug: `${TAG}-usd` },
  };
  let usdOfferId = 0;
  const observedAt = new Date("2026-10-14T21:30:00Z");

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const u = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`${TAG}@test.local`],
      );
      admin = { userId: Number(u.rows[0].id), role: "moderator" };
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active)
         VALUES ($1, 'Kaynak Test', $2, 'xml_feed', true) RETURNING id`,
        [`${TAG}-m`, `${TAG}.test`],
      );
      merchantId = Number(m.rows[0].id);
      const c = await client.query(
        "SELECT id FROM category WHERE is_discoverable ORDER BY id LIMIT 1",
      );
      categoryId = Number(c.rows[0]?.id ?? 0);

      const offer = async (n: number, currency: string, price: number, productId: number) => {
        const r = await client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url, current_price,
                              currency, product_id)
           VALUES ($1, $2, $3, $4, 'https://img.test/a.jpg', $5, $6, $7) RETURNING id`,
          [
            merchantId,
            `${TAG}-${n}`,
            `https://${TAG}.test/${n}`,
            `${TAG} teklif ${n}`,
            price,
            currency,
            productId,
          ],
        );
        return Number(r.rows[0].id);
      };
      const product = async (
        key: keyof typeof p,
        state: "published" | "draft" | "held",
        source: boolean,
      ) => {
        const r = await client.query(
          `INSERT INTO product (slug, title, primary_image_url, category_id, model_key,
                                publication_state, hold_reason, source_merchant_id,
                                source_external_id)
           VALUES ($1, $2, 'https://img.test/a.jpg', $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            p[key].slug,
            `${TAG} ${key} kulaklik`,
            categoryId || null,
            MODEL,
            state,
            state === "held" ? "stale_source_offer" : null,
            source ? merchantId : null,
            source ? sourceIdOf(key) : null,
          ],
        );
        p[key].id = Number(r.rows[0].id);
      };
      await product("published", "published", false);
      await product("draft", "draft", true);
      await product("held", "held", true);
      await product("usd", "published", true);

      // Yayınlanmış TRY ürün; ayrıca "sızıntı" senaryosu: taslağa/bekleyene yanlışlıkla TRY
      // teklif bağlanmış olsa bile hiçbir yüzey göstermemeli.
      await offer(1, "TRY", 25000, p.published.id);
      await offer(2, "TRY", 25000, p.draft.id);
      await offer(3, "TRY", 25000, p.held.id);
      usdOfferId = await offer(4, "USD", 1299, p.usd.id);
      await client.query(
        "INSERT INTO price_point (offer_id, observed_at, price, in_stock) VALUES ($1, $2, 1299, true)",
        [usdOfferId, observedAt],
      );
    });
    for (const key of ["published", "draft", "held", "usd"] as const) {
      await refreshProductAggregates(db, { productIds: [p[key].id] });
    }
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      const ids = Object.values(p).map((x) => x.id);
      await client.query("DELETE FROM price_point WHERE offer_id = $1", [usdOfferId]);
      await client.query("UPDATE offer SET product_id = NULL WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [ids]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [admin.userId]);
    });
  });

  it("taslak ve bekleyen ürün sayfası yok (404), yayınlanmış var", async () => {
    expect((await resolveProductSlug(db, p.draft.slug)).status).toBe("not_found");
    expect((await resolveProductSlug(db, p.held.slug)).status).toBe("not_found");
    expect((await resolveProductSlug(db, p.published.slug)).status).toBe("found");
    expect((await resolveProductSlug(db, p.usd.slug)).status).toBe("found");
  });

  it("metin araması yalnızca yayınlanmış ürünü bulur", async () => {
    const result = await search(db, textQuery(TAG), { limit: 50 });
    const slugs = result.items.map((item) => item.slug);
    expect(slugs).toContain(p.published.slug);
    expect(slugs).not.toContain(p.draft.slug);
    expect(slugs).not.toContain(p.held.slug);
    // USD-only ürünün TL özeti yok: TL fiyat kartına girmez.
    expect(slugs).not.toContain(p.usd.slug);
  });

  it("renk kardeşleri ve site haritası taslağı/bekleyeni görmez", async () => {
    const siblings = await getColorVariants(db, MODEL, p.published.id);
    expect(siblings.map((s) => s.slug)).toEqual([p.usd.slug]);

    const maxId = Math.max(...Object.values(p).map((x) => x.id));
    const minId = Math.min(...Object.values(p).map((x) => x.id)) - 1;
    const eligible = await listSitemapEligibleProducts(db, { minId, maxId });
    const slugs = eligible.map((e) => e.slug);
    expect(slugs).not.toContain(p.draft.slug);
    expect(slugs).not.toContain(p.held.slug);
    // USD-only ürün TL teklif sayısı 0 olduğu için haritaya da girmez.
    expect(slugs).not.toContain(p.usd.slug);
  });

  it("internet sonuçlarının katalog görseli adayları taslağı/bekleyeni kullanmaz", async () => {
    const found = await findCatalogImageCandidates(db, [
      { title: `${TAG} draft kulaklik`, brand: null },
      { title: `${TAG} held kulaklik`, brand: null },
      { title: `${TAG} published kulaklik`, brand: null },
    ]);
    const titles = found.map((c) => c.title);
    expect(titles).toContain(`${TAG} published kulaklik`);
    expect(titles.some((t) => t.includes(" draft ") || t.includes(" held "))).toBe(false);
  });

  it("USD teklif fiyat özetine girmez; kendi para birimi ve fiyat zamanıyla gösterilir", async () => {
    const [row] = (
      await db.execute<{ min_price: string | null; offer_count: number }>(
        sql`SELECT min_price, offer_count FROM product WHERE id = ${p.usd.id}`,
      )
    ).rows;
    expect(row?.min_price).toBeNull();
    expect(row?.offer_count).toBe(0);

    expect(await compareMerchants(db, p.usd.id)).toEqual([]);

    const foreign = await getProductForeignOffers(db, p.usd.id);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ offerId: usdOfferId, currency: "USD", priceMinor: 1299 });
    expect(foreign[0]?.priceObservedAt.toISOString()).toBe(observedAt.toISOString());
    // TRY ürün yurt dışı bloğu üretmez.
    expect(await getProductForeignOffers(db, p.published.id)).toEqual([]);
  });

  it("yönetim ürün araması varsayılan olarak taslakları saklar; durum ve kaynak kimliyle bulunur", async () => {
    const byDefault = await searchProducts(db, admin, { query: TAG });
    const slugs = byDefault.rows.map((r) => r.slug);
    expect(slugs).toContain(p.published.slug);
    expect(slugs).not.toContain(p.draft.slug);

    const drafts = await searchProducts(db, admin, { state: "draft", query: p.draft.slug });
    expect(drafts.rows.map((r) => r.slug)).toEqual([p.draft.slug]);

    const held = await searchProducts(db, admin, { state: "held", query: p.held.slug });
    expect(held.rows.map((r) => r.slug)).toEqual([p.held.slug]);

    const sourceId = sourceIdOf("draft");
    const bySource = await searchProducts(db, admin, { state: "all", query: sourceId });
    expect(bySource.rows.map((r) => r.slug)).toEqual([p.draft.slug]);
  });

  it("kalite paneli yayın bekleyen ilanları sayar ve yayınlanmış ürün sayımlarına karışmaz", async () => {
    const check = CATALOG_QUALITY_CHECKS.find((c) =>
      c.keys.some((k) => k.key === "catalog.source_listing_backlog"),
    );
    expect(check).toBeDefined();
    const found = await db.transaction(async (tx) => check?.run(tx) ?? []);
    const backlog = found.find((f) => f.key === "catalog.source_listing_backlog");
    expect(backlog?.count).toBeGreaterThanOrEqual(2);
    expect(backlog?.evidence).toMatch(/taslak/);
  });

  it("bir ilan için ikinci ürün oluşturulamaz (DB benzersizliği)", async () => {
    await withOwnerClient(async (client) => {
      await expect(
        client.query(
          `INSERT INTO product (slug, title, source_merchant_id, source_external_id, publication_state)
           SELECT $1, 'Yinelenen', source_merchant_id, source_external_id, 'draft'
             FROM product WHERE id = $2`,
          [`${TAG}-yinelenen`, p.draft.id],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });
});
