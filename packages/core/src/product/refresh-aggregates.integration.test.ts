/**
 * Ürün fiyat özeti TypeScript yazanlarında aynı işlemde yenilenir (karar 0072):
 * yönetimde eşleştirme onayı ve mağaza aç/kapat. Üretim hatası: özet bayat
 * kalınca kart "0 mağaza" diyor, bütçe araması (`p.min_price`) ürünü görmüyordu.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { approveMatch } from "../admin/matching-queue.ts";
import { setMerchantActive } from "../admin/merchants.ts";
import { search } from "../search/search.ts";
import type { QueryObject } from "../search/types.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { refreshProductAggregates, runProductAggregateRepair } from "./refresh-aggregates.ts";

const suffix = Date.now();
// Yalnızca harf: başlık metin kapısında tek parça token olarak eşleşir.
const TAG = `ozetzq${suffix.toString(36).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)] ?? "")}`;

function budgetQuery(priceMax: number): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: TAG,
    filters: { price_max: priceMax },
    style_tags: [],
    sort: "balanced",
    unparsed: TAG,
    confidence: 1,
  };
}

describe("ürün fiyat özeti - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  const merchants: Record<"a" | "b", { id: number; slug: string }> = {
    a: { id: 0, slug: `ozet-a-${suffix}` },
    b: { id: 0, slug: `ozet-b-${suffix}` },
  };
  const products: Record<"matched" | "shared" | "other", number> = {
    matched: 0,
    shared: 0,
    other: 0,
  };
  let candidateId = 0;
  const startedAt = new Date();

  const aggregates = (id: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT offer_count, min_price::int AS min_price, max_price::int AS max_price,
                in_stock_count, updated_at
           FROM product WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      return {
        counts: [row.offer_count, row.min_price, row.max_price, row.in_stock_count],
        updatedAt: row.updated_at as Date,
      };
    });

  const found = async (priceMax: number) =>
    (await search(db, budgetQuery(priceMax), { limit: 50 })).items
      .filter((item) => item.title.startsWith(TAG))
      .map((item) => ({ title: item.title, offerCount: item.offerCount }));

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`ozet-admin-${suffix}@test.local`],
      );
      admin = { userId: Number(user.rows[0].id), role: "admin" };

      for (const key of ["a", "b"] as const) {
        const res = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $2, $3, 'xml_feed', TRUE) RETURNING id`,
          [merchants[key].slug, `Özet ${key}`, `${merchants[key].slug}.test`],
        );
        merchants[key].id = Number(res.rows[0].id);
      }

      const category = await client.query(
        "SELECT id FROM category WHERE is_discoverable ORDER BY id LIMIT 1",
      );
      for (const key of ["matched", "shared", "other"] as const) {
        const res = await client.query(
          `INSERT INTO product (slug, title, category_id, primary_image_url)
           VALUES ($1, $2, $3, 'https://img.test/ozet.jpg') RETURNING id`,
          [`${TAG}-${key}`, `${TAG} ${key} lamba`, category.rows[0].id],
        );
        products[key] = Number(res.rows[0].id);
      }

      const offer = async (merchant: number, ext: string, price: number, product: number | null) =>
        Number(
          (
            await client.query(
              `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price,
                                  in_stock, product_id)
               VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING id`,
              [merchant, ext, `https://ozet.test/${ext}`, `${TAG} ${ext}`, price, product],
            )
          ).rows[0].id,
        );

      // Henüz bağlanmamış teklif + bekleyen aday (eşleştirme kuyruğu).
      const unmatched = await offer(merchants.a.id, "m-1", 432100, null);
      const candidate = await client.query(
        `INSERT INTO match_candidate (offer_id, product_id, score, method, status)
         VALUES ($1, $2, 0.9, 'text', 'pending') RETURNING id`,
        [unmatched, products.matched],
      );
      candidateId = Number(candidate.rows[0].id);

      // İki mağazada satılan ürün; özet bilerek bayat bırakılır.
      await offer(merchants.a.id, "s-a", 50000, products.shared);
      await offer(merchants.b.id, "s-b", 30000, products.shared);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      const ids = [merchants.a.id, merchants.b.id];
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = $1", [admin.userId]);
      await client.query(
        "DELETE FROM match_candidate WHERE offer_id IN (SELECT id FROM offer WHERE merchant_id = ANY($1))",
        [ids],
      );
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [ids]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [Object.values(products)]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [ids]);
      await client.query("DELETE FROM app_user WHERE id = $1", [admin.userId]);
      await client.query(
        "DELETE FROM job_run WHERE job = 'product_aggregates' AND started_at >= $1",
        [startedAt],
      );
    });
  });

  it("eşleştirme onayı ürünü aynı işlemde fiyat ve mağaza sayısıyla bütçe aramasına sokar", async () => {
    expect((await aggregates(products.matched)).counts).toEqual([0, null, null, 0]);
    expect(await found(500000)).toEqual([]);

    const result = await approveMatch(db, admin, candidateId);
    expect(result).toMatchObject({ found: true });

    expect((await aggregates(products.matched)).counts).toEqual([1, 432100, 432100, 1]);
    expect(await found(500000)).toContainEqual({ title: `${TAG} matched lamba`, offerCount: 1 });
    expect((await found(400000)).map((item) => item.title)).not.toContain(`${TAG} matched lamba`);
  });

  it("kapsamlı yenileme yalnızca verilen ürünü yazar; boş kapsam hiçbir şey yazmaz", async () => {
    const otherBefore = await aggregates(products.other);
    expect(await refreshProductAggregates(db, { productIds: [] })).toBe(0);
    expect(await refreshProductAggregates(db, { productIds: [products.shared] })).toBe(1);
    expect(await refreshProductAggregates(db, { productIds: [products.shared] })).toBe(0);

    expect((await aggregates(products.shared)).counts).toEqual([2, 30000, 50000, 2]);
    expect(await aggregates(products.other)).toEqual(otherBefore);
  });

  it("mağaza kapatma pasif mağazanın fiyatını ve sayısını aynı işlemde düşürür; açma geri getirir", async () => {
    const toggle = (active: boolean) =>
      setMerchantActive(db, admin, {
        merchantId: merchants.b.id,
        active,
        reason: "özet testi gerekçesi",
        confirmSlug: merchants.b.slug,
      });

    await toggle(false);
    // Arama B'nin 300 TL teklifini kullanamaz; özet de 500 TL ve 1 mağaza der.
    expect((await aggregates(products.shared)).counts).toEqual([1, 50000, 50000, 1]);
    expect((await found(40000)).map((item) => item.title)).not.toContain(`${TAG} shared lamba`);
    expect(await found(60000)).toContainEqual({ title: `${TAG} shared lamba`, offerCount: 1 });

    await toggle(true);
    expect((await aggregates(products.shared)).counts).toEqual([2, 30000, 50000, 2]);
    expect(await found(40000)).toContainEqual({ title: `${TAG} shared lamba`, offerCount: 2 });
  });

  it("günlük onarım atlanmış yolu düzeltir, tekrarında 0 satır yazar ve job_run'a kaydolur", async () => {
    await withOwnerClient((client) =>
      client.query("UPDATE product SET offer_count = 9, min_price = 1 WHERE id = $1", [
        products.other,
      ]),
    );

    const first = await runProductAggregateRepair(db);
    expect(first.updated).toBeGreaterThanOrEqual(1);
    expect((await aggregates(products.other)).counts).toEqual([0, null, null, 0]);

    // Paralel test dosyaları kendi fikstürlerini yazdığı için genel "0 satır"
    // burada beklenmez (Python testi onu seri koşuda doğrular); bu testin
    // ürünleri ikinci koşuda yeniden YAZILMAMALI (updated_at dahil aynı).
    const mine = Object.values(products);
    const before = await Promise.all(mine.map(aggregates));
    await runProductAggregateRepair(db);
    expect(await Promise.all(mine.map(aggregates))).toEqual(before);

    const runs = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT status, trigger FROM job_run
          WHERE job = 'product_aggregates' AND started_at >= $1 ORDER BY id`,
        [startedAt],
      );
      return res.rows;
    });
    expect(runs).toEqual([
      { status: "success", trigger: "cron" },
      { status: "success", trigger: "cron" },
    ]);
  });
});
