/**
 * Yönetim > Katalog > Ürünler: birleşik filtreler, anahtar kümeli sayfalama, sağ
 * panel ve sınıflandırma izleme (karar 0133 verisinin gösterimi). Gerçek Postgres.
 *
 * Dört ürün (başlıkta ortak bir belirteç; liste bu belirteçle daraltılır):
 * - a: markalı, alt kategoride, görselli, TL fiyatlı (başka mağaza), sınıflandırma
 *   uygulandı (güven 95, sistem kategori yazdı), fiyat özeti bugün.
 * - b: markasız, kategorisiz, görselsiz, yalnız USD (kaynak mağaza), inceleme (60),
 *   fiyat özeti 10 gün önce.
 * - c: markasız, üst kategoride, görselli, fiyatsız, hata (0).
 * - d: taslak, taranmadı.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { AdminActor } from "./capabilities.ts";
import { type ProductSearchFilter, searchProducts } from "./catalog.ts";
import {
  getClassificationMonitor,
  getProductPanel,
  listProductFilterOptions,
} from "./catalog-panel.ts";

describe("yönetim ürün listesi: filtreler, panel, izleme - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now().toString(36);
  const token = `brw${suffix}`;
  let moderator: AdminActor;
  let userId = 0;
  const merchants = { src: "", other: "" };
  const merchantIds = { src: 0, other: 0 };
  let brandId = 0;
  const brandName = `Zebra${suffix}`;
  let parentPath = "";
  let childPath = "";
  const ids = { a: 0, b: 0, c: 0, d: 0 };
  const offerIds = { aOther: 0, bSource: 0 };
  let savedState: Record<string, unknown>[] = [];
  let jobRunId = 0;

  const list = async (filter: ProductSearchFilter) =>
    (await searchProducts(db, moderator, { query: token, ...filter })).rows.map((r) => r.id).sort();

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`brw-mod-${suffix}@test.local`],
      );
      userId = Number(user.rows[0].id);
      moderator = { userId, role: "moderator" };

      for (const key of ["src", "other"] as const) {
        merchants[key] = `brw-${key}-${suffix}`;
        const res = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $2, $3, 'xml_feed', TRUE) RETURNING id`,
          [merchants[key], `Brw ${key}`, `${merchants[key]}.example`],
        );
        merchantIds[key] = Number(res.rows[0].id);
      }
      const brand = await client.query(
        "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
        [`zebra-${suffix}`, brandName, `zebra${suffix}`],
      );
      brandId = Number(brand.rows[0].id);
      const child = await client.query(
        `SELECT c.path AS child, p.path AS parent FROM category c
           JOIN category p ON p.id = c.parent_id
          WHERE p.parent_id IS NOT NULL ORDER BY c.path LIMIT 1`,
      );
      childPath = child.rows[0].child;
      parentPath = child.rows[0].parent;
      const catId = async (path: string) =>
        Number((await client.query("SELECT id FROM category WHERE path = $1", [path])).rows[0].id);

      const product = async (
        key: keyof typeof ids,
        columns: Record<string, unknown>,
        state = "published",
      ) => {
        const base: Record<string, unknown> = {
          slug: `brw-${key}-${suffix}`,
          title: `Brw ${key} ${token}`,
          source_merchant_id: merchantIds.src,
          source_external_id: `${key}-${suffix}`,
          publication_state: state,
          published_at: state === "published" ? new Date() : null,
          ...columns,
        };
        const cols = Object.keys(base);
        const res = await client.query(
          `INSERT INTO product (${cols.join(", ")})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
          cols.map((c) => base[c]),
        );
        ids[key] = Number(res.rows[0].id);
      };
      await product("a", {
        brand_id: brandId,
        category_id: await catId(childPath),
        primary_image_url: "https://img.example/a.jpg",
        min_price: 129_900,
        offer_count: 1,
        in_stock_count: 1,
        price_updated_at: new Date(),
      });
      await product("b", {
        foreign_offer_count: 1,
        price_updated_at: new Date(Date.now() - 10 * 86_400_000),
      });
      await product("c", {
        category_id: await catId(parentPath),
        primary_image_url: "https://img.example/c.jpg",
      });
      await product("d", {}, "draft");

      const offer = async (merchant: number, product: number, price: number, currency: string) =>
        Number(
          (
            await client.query(
              `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                                  current_price, currency, in_stock, is_active)
               VALUES ($1, $2, $3, $4, 'Brw teklif', $5, $6, TRUE, TRUE) RETURNING id`,
              [
                merchant,
                product,
                `o-${product}-${merchant}`,
                `https://x.example/${product}`,
                price,
                currency,
              ],
            )
          ).rows[0].id,
        );
      offerIds.aOther = await offer(merchantIds.other, ids.a, 129_900, "TRY");
      offerIds.bSource = await offer(merchantIds.src, ids.b, 1_234, "USD");
      await client.query("UPDATE product SET source_offer_id = $1 WHERE id = $2", [
        offerIds.bSource,
        ids.b,
      ]);

      const classify = async (
        key: keyof typeof ids,
        state: string,
        confidence: number,
        categoryBasis: string,
        extra: { wroteCategory?: boolean; detail?: string | null; brand?: number | null } = {},
      ) =>
        client.query(
          `INSERT INTO product_classification (product_id, rule_version, state, brand_id, brand_basis,
                                               category_basis, confidence, compatible_brands,
                                               wrote_category, detail)
           VALUES ($1, 3, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            ids[key],
            state,
            extra.brand ?? null,
            extra.brand ? "existing" : "none",
            categoryBasis,
            confidence,
            key === "a" ? ["apple"] : null,
            extra.wroteCategory ?? false,
            extra.detail ?? null,
          ],
        );
      await classify("a", "applied", 95, "source", { wroteCategory: true, brand: brandId });
      await classify("b", "review", 60, "low_confidence", { detail: "weak_title" });
      await classify("c", "error", 0, "none", { detail: "concurrent_change" });

      savedState = (await client.query("SELECT * FROM product_classification_state")).rows;
      await client.query("DELETE FROM product_classification_state");
      await client.query(
        `INSERT INTO product_classification_state
           (rule_version, scope, last_product_id, scanned, brand_set, category_set, review, errors,
            updated_at)
         VALUES (3, 'all', $1, 3, 0, 1, 1, 1, now())`,
        [ids.c],
      );
      const run = await client.query(
        "INSERT INTO job_run (job, status) VALUES ('classify_products', 'running') RETURNING id",
      );
      jobRunId = Number(run.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM job_run WHERE id = $1", [jobRunId]);
      await client.query(
        "UPDATE product SET source_offer_id = NULL WHERE source_merchant_id = $1",
        [merchantIds.src],
      );
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1::bigint[])", [
        [merchantIds.src, merchantIds.other],
      ]);
      await client.query("DELETE FROM product WHERE source_merchant_id = $1", [merchantIds.src]);
      await client.query("DELETE FROM brand WHERE id = $1", [brandId]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1::bigint[])", [
        [merchantIds.src, merchantIds.other],
      ]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
      await client.query("DELETE FROM product_classification_state");
      for (const row of savedState) {
        const cols = Object.keys(row);
        await client.query(
          `INSERT INTO product_classification_state (${cols.join(", ")})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((c) => row[c]),
        );
      }
    });
  });

  const sorted = (...keys: (keyof typeof ids)[]) => keys.map((k) => ids[k]).sort();

  it("varsayılan yalnız yayındakiler; 'all' taslağı da getirir", async () => {
    expect(await list({})).toEqual(sorted("a", "b", "c"));
    expect(await list({ state: "all" })).toEqual(sorted("a", "b", "c", "d"));
    expect(await list({ state: "draft" })).toEqual(sorted("d"));
  });

  it("mağaza: aktif teklifi olan mağaza", async () => {
    expect(await list({ merchant: merchants.other })).toEqual(sorted("a"));
    expect(await list({ merchant: merchants.src })).toEqual(sorted("b"));
    expect(await list({ merchant: "yok-boyle-magaza" })).toEqual([]);
  });

  it("marka: kimlik, ad (harf duyarsız), atanmamış", async () => {
    expect(await list({ brand: brandId })).toEqual(sorted("a"));
    expect(await list({ brand: { name: brandName.toUpperCase() } })).toEqual(sorted("a"));
    expect(await list({ brand: "none" })).toEqual(sorted("b", "c"));
  });

  it("kategori: alt dallar dahil; atanmamış", async () => {
    expect(await list({ category: parentPath })).toEqual(sorted("a", "c"));
    expect(await list({ category: childPath })).toEqual(sorted("a"));
    expect(await list({ category: "none" })).toEqual(sorted("b"));
  });

  it("sınıflandırma durumu ve güven puanı", async () => {
    expect(await list({ classification: "applied" })).toEqual(sorted("a"));
    expect(await list({ classification: "auto_written" })).toEqual(sorted("a"));
    expect(await list({ classification: "review" })).toEqual(sorted("b"));
    expect(await list({ classification: "error" })).toEqual(sorted("c"));
    expect(await list({ classification: "unscanned" })).toEqual([]);
    expect(await list({ classification: "unscanned", state: "all" })).toEqual(sorted("d"));
    expect(await list({ confidence: "high" })).toEqual(sorted("a"));
    expect(await list({ confidence: "medium" })).toEqual(sorted("b"));
    expect(await list({ confidence: "low" })).toEqual(sorted("c"));
  });

  it("fiyat, görsel ve fiyat özeti güncelliği", async () => {
    expect(await list({ price: "try" })).toEqual(sorted("a"));
    expect(await list({ price: "foreign_only" })).toEqual(sorted("b"));
    expect(await list({ price: "none" })).toEqual(sorted("c"));
    expect(await list({ image: "with" })).toEqual(sorted("a", "c"));
    expect(await list({ image: "without" })).toEqual(sorted("b"));
    expect(await list({ freshness: "1d" })).toEqual(sorted("a"));
    expect(await list({ freshness: "30d" })).toEqual(sorted("a", "b"));
    expect(await list({ freshness: "stale" })).toEqual(sorted("b", "c"));
  });

  it("filtreler birlikte (AND) ve eski kalite filtresiyle çalışır", async () => {
    expect(await list({ category: parentPath, image: "with", classification: "error" })).toEqual(
      sorted("c"),
    );
    expect(await list({ quality: "no_brand", price: "none" })).toEqual(sorted("c"));
    expect(await list({ brand: brandId, price: "none" })).toEqual([]);
  });

  it("satır: yayın durumu, kaynak mağaza, teklif mağazaları ve sınıflandırma özeti", async () => {
    const result = await searchProducts(db, moderator, { query: token, state: "all" });
    const a = result.rows.find((r) => r.id === ids.a);
    const d = result.rows.find((r) => r.id === ids.d);
    expect(a?.publicationState).toBe("published");
    expect(a?.sourceMerchant?.slug).toBe(merchants.src);
    expect(a?.classification).toMatchObject({
      state: "applied",
      confidence: 95,
      categoryBasis: "source",
      wroteCategory: true,
      ruleVersion: 3,
    });
    expect(result.merchants.get(ids.a)?.map((m) => m.slug)).toEqual([merchants.other]);
    expect(d?.publicationState).toBe("draft");
    expect(d?.classification).toBeNull();
    const b = result.rows.find((r) => r.id === ids.b);
    expect(b?.foreignPrices).toEqual([{ currency: "USD", minPrice: 1_234 }]);
  });

  it("anahtar kümeli sayfalama: sonraki ve önceki sayfa aynı sırayı korur", async () => {
    const all = await searchProducts(db, moderator, { query: token, state: "all" });
    const order = all.rows.map((r) => r.id);
    expect(order).toEqual([...order].sort((x, y) => y - x));
    expect(all.hasPrev).toBe(false);
    expect(all.hasNext).toBe(false);

    const next = await searchProducts(db, moderator, {
      query: token,
      state: "all",
      before: order[1],
    });
    expect(next.rows.map((r) => r.id)).toEqual(order.slice(2));
    expect(next.hasPrev).toBe(true);
    expect(next.prevAfter).toBe(order[2]);

    const prev = await searchProducts(db, moderator, {
      query: token,
      state: "all",
      after: order[2],
    });
    // Önceki sayfa yine en yeni önce gelir.
    expect(prev.rows.map((r) => r.id)).toEqual(order.slice(0, 2));
    expect(prev.hasNext).toBe(true);
    expect(prev.nextBefore).toBe(order[1]);
  });

  it("panel: kaynak teklif, gerçek para birimi ve karar dayanağı", async () => {
    const b = await getProductPanel(db, moderator, ids.b);
    expect(b?.sourceMerchant?.slug).toBe(merchants.src);
    expect(b?.sourceOffer).toMatchObject({ id: offerIds.bSource, currency: "USD", price: 1_234 });
    expect(b?.sourceOffer?.isSource).toBe(true);
    expect(b?.classification).toMatchObject({
      state: "review",
      confidence: 60,
      categoryBasis: "low_confidence",
      detail: "weak_title",
    });
    expect(b?.minPrice).toBeNull();

    const a = await getProductPanel(db, moderator, ids.a);
    expect(a?.brand).toEqual({ id: brandId, name: brandName });
    expect(a?.category?.path).toBe(childPath);
    expect(a?.offers.map((o) => [o.merchantSlug, o.currency, o.price])).toEqual([
      [merchants.other, "TRY", 129_900],
    ]);
    expect(a?.classification?.brandName).toBe(brandName);
    expect(a?.classification?.compatibleBrands).toEqual(["apple"]);
    expect(a?.classification?.wroteCategory).toBe(true);

    const d = await getProductPanel(db, moderator, ids.d);
    expect(d?.publicationState).toBe("draft");
    expect(d?.classification).toBeNull();

    expect(await getProductPanel(db, moderator, 9_007_199_254_740)).toBeNull();
    expect(await getProductPanel(db, moderator, -1)).toBeNull();
  });

  it("izleme: kontrol noktası, son ürün, açık satırlar ve koşu durumu gerçek kayıttan", async () => {
    const monitor = await getClassificationMonitor(db, moderator);
    expect(monitor.current).toMatchObject({ ruleVersion: 3, scope: "all", scanned: 3 });
    expect(monitor.lastProduct).toEqual({ id: ids.c, title: `Brw c ${token}` });
    expect(monitor.openReview).toBeGreaterThanOrEqual(1);
    expect(monitor.openErrors).toBeGreaterThanOrEqual(1);
    expect(monitor.open.some((r) => r.state === "review" && r.detail === "weak_title")).toBe(true);
    expect(monitor.runs[0]?.id).toBe(jobRunId);
    expect(monitor.status).toBe("running");
    expect(monitor.maxProductId).toBeGreaterThanOrEqual(ids.d);
  });

  it("filtre seçenekleri mağaza ve kategori ağacını verir", async () => {
    const options = await listProductFilterOptions(db, moderator);
    expect(options.merchants.some((m) => m.slug === merchants.src)).toBe(true);
    expect(options.categories.find((c) => c.path === childPath)?.depth).toBeGreaterThan(1);
  });

  it("hepsi catalog.read ister", async () => {
    const user = { userId, role: "user" } as unknown as AdminActor;
    await expect(searchProducts(db, user, {})).rejects.toThrow();
    await expect(getProductPanel(db, user, ids.a)).rejects.toThrow();
    await expect(getClassificationMonitor(db, user)).rejects.toThrow();
    await expect(listProductFilterOptions(db, user)).rejects.toThrow();
  });
});
