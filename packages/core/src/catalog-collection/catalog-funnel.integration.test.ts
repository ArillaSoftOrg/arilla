import type { Database } from "@arilla/db";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { compareMerchants } from "../search/compare-merchants.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getCatalogFunnel } from "./catalog-funnel.ts";

/** Karar 0129: Hepsiburada katalog hunisi gercek Postgres'te; sentetik veri, istek yok. */
describe("katalog hunisi - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  let createdMerchant = false;
  let merchantId = 0;
  const suffix = Date.now();
  const email = `funnel-${suffix}@test.local`;
  const img = (c: string) => `https://productimages.hepsiburada.net/s/${c}.jpg`;

  async function clean(c: Client) {
    const products = "SELECT id FROM product WHERE source_merchant_id = $1";
    await c.query(`UPDATE offer SET product_id = NULL WHERE merchant_id = $1`, [merchantId]);
    await c.query(`DELETE FROM product WHERE id IN (${products})`, [merchantId]);
    await c.query("DELETE FROM catalog_build_state WHERE merchant_id = $1", [merchantId]);
    await c.query("DELETE FROM catalog_discovery_build_state");
    await c.query(
      "DELETE FROM ingest_error WHERE feed_source_id IN (SELECT id FROM feed_source WHERE network = 'hbcollect' AND external_id = 'test-funnel')",
    );
    await c.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
    await c.query(
      "DELETE FROM feed_source WHERE network = 'hbcollect' AND external_id = 'test-funnel'",
    );
    await c.query("DELETE FROM catalog_discovery");
    await c.query("DELETE FROM catalog_intake_record");
    await c.query("DELETE FROM collection_unit");
    await c.query("DELETE FROM collection_run");
    await c.query("DELETE FROM collection_usage_day");
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const user = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [email],
      );
      admin = { userId: Number(user.rows[0].id), role: "admin" };
      const existing = await c.query("SELECT id FROM merchant WHERE slug = 'hepsiburada'");
      if (existing.rows[0]) {
        merchantId = Number(existing.rows[0].id);
      } else {
        const m = await c.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ('hepsiburada', 'Hepsiburada', 'hepsiburada.com', 'user_discovered', TRUE)
           RETURNING id`,
        );
        merchantId = Number(m.rows[0].id);
        createdMerchant = true;
      }
      await clean(c);
      await c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'hepsiburada'");
      // Arama toplayicisi: 3 kayit, 2'si birlestirildi.
      const run = Number(
        (
          await c.query(
            `INSERT INTO collection_run (source, expires_at, max_requests)
             VALUES ('hepsiburada', now(), 10) RETURNING id`,
          )
        ).rows[0].id,
      );
      for (const [code, merged] of [
        ["HBCVF1", true],
        ["HBCVF2", true],
        ["HBCVF3", false],
      ] as const) {
        await c.query(
          `INSERT INTO catalog_intake_record (run_id, external_id, title, url, price_minor,
                                              currency, in_stock, source_observed_at)
           VALUES ($1, $2, $3, $4, 1000, 'TRY', TRUE, now())`,
          [run, code, `Urun ${code}`, `https://www.hepsiburada.com/u-p-${code}`],
        );
        if (merged) {
          await c.query(
            "UPDATE catalog_intake_record SET merged_at = now() WHERE external_id = $1",
            [code],
          );
        }
      }
      // Sitemap: 3 kesif satiri, 1'i liste fiyatiyla goruldu.
      for (const [code, state] of [
        ["HBCF1", "unpriced"],
        ["HBCF2", "unpriced"],
        ["HBCF3", "listing_price"],
      ] as const) {
        await c.query(
          `INSERT INTO catalog_discovery (source, external_id, code_kind, url, title, image_url,
                                          source_unit_key, first_seen_run_id, last_seen_run_id,
                                          price_state, price_checked_at)
           VALUES ('hepsiburada', $1, 'pm', $2, $3, $4, 'u1', $5, $5, $6,
                   CASE WHEN $6 = 'unpriced' THEN NULL ELSE now() END)`,
          [
            code,
            `https://www.hepsiburada.com/k-pm-${code}`,
            `Kesif ${code}`,
            img(code),
            run,
            state,
          ],
        );
      }
      await c.query("UPDATE collection_run SET status = 'completed' WHERE id = $1", [run]);

      // Teklifler: 1 bilinmeyen stoklu, 1 stokta.
      const feed = Number(
        (
          await c.query(
            `INSERT INTO feed_source (network, external_id, merchant_id, name, format, status,
                                      currency, market)
             VALUES ('hbcollect', 'test-funnel', $1, 'Test', 'ndjson', 'active', 'TRY', 'TR')
             RETURNING id`,
            [merchantId],
          )
        ).rows[0].id,
      );
      const offer = async (code: string, inStock: boolean, stockState: string) =>
        Number(
          (
            await c.query(
              `INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url,
                                  current_price, currency, in_stock, attributes_raw, feed_source_id)
               VALUES ($1, $2, $3, $4, $5, 129900, 'TRY', $6, $7::jsonb, $8) RETURNING id`,
              [
                merchantId,
                code,
                `https://www.hepsiburada.com/u-p-${code}`,
                `Urun ${code}`,
                img(code),
                inStock,
                JSON.stringify({ stock_state: stockState }),
                feed,
              ],
            )
          ).rows[0].id,
        );
      const unknownOffer = await offer("HBCVF1", false, "unknown");
      const availableOffer = await offer("HBCVF2", true, "available");

      // Urunler: yayinlanmis (bilinmeyen stoklu teklifle), hazir, fiyat bekleyen, gorselsiz.
      const product = async (
        code: string,
        state: string,
        reason: string | null,
        offerId: number | null,
      ) =>
        Number(
          (
            await c.query(
              `INSERT INTO product (slug, title, primary_image_url, source_merchant_id,
                                    source_external_id, source_offer_id, publication_state,
                                    hold_reason)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
              [
                `test-funnel-${code}-${suffix}`,
                `Urun ${code}`,
                img(code),
                merchantId,
                code,
                offerId,
                state,
                reason,
              ],
            )
          ).rows[0].id,
        );
      const published = await product("HBCVF1", "published", null, unknownOffer);
      await c.query("UPDATE offer SET product_id = $1 WHERE id = $2", [published, unknownOffer]);
      await product("HBCVF2", "ready", null, availableOffer);
      await product("HBCF1", "held", "source_offer_missing", null);
      await product("HBCF2", "held", "no_image", null);
      await product("HBCF9", "draft", null, null);

      await c.query(
        `INSERT INTO ingest_error (feed_source_id, external_id, error_code, detail)
         VALUES ($1, 'HBCVF9', 'price_jump_held', 'test')`,
        [feed],
      );
      await c.query(
        `INSERT INTO catalog_build_state (merchant_id, scanned, created, skipped, completed_at)
         VALUES ($1, 3, 2, '{"source_id_url_mismatch": 1}'::jsonb, now())`,
        [merchantId],
      );
      await c.query(
        `INSERT INTO catalog_discovery_build_state (source, last_external_id, scanned, created,
                                                    skipped)
         VALUES ('hepsiburada', 'HBCF3', 3, 2, '{"no_title": 1}'::jsonb)`,
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await clean(c);
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'");
      if (createdMerchant) await c.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await c.query("DELETE FROM app_user WHERE email = $1", [email]);
    });
  });

  it("iki toplayicinin kayitlarini ve urun asamalarini ayri sayar", async () => {
    const f = await getCatalogFunnel(db, admin, "hepsiburada");
    expect(f.merchantFound).toBe(true);
    expect(f.intake).toEqual({
      total: { value: 3, capped: false },
      merged: { value: 2, capped: false },
      pending: 1,
    });
    expect(f.discovery).toEqual({
      total: { value: 3, capped: false },
      listingPrice: 1,
      pageVerified: 0,
      stale: 0,
    });
    expect(f.offers).toEqual({ total: 2, active: 2, linkedToProduct: 1, stockUnknown: 1 });
    expect(f.products).toEqual({
      total: 5,
      draft: 1,
      ready: 1,
      held: 2,
      published: 1,
      heldReasons: { source_offer_missing: 1, no_image: 1 },
    });
    expect(f.pricedProducts).toBe(2);
    expect(f.awaitingPriceProducts).toBe(1);
    expect(f.problems).toEqual({
      priceJumpHeld: 1,
      offerBuildSkipped: { source_id_url_mismatch: 1 },
      discoveryBuildSkipped: { no_title: 1 },
    });
    expect(f.checkpoints.discoveryBuildLastId).toBe("HBCF3");
    expect(f.checkpoints.offerBuildCompletedAt).toBeInstanceOf(Date);
  });

  it("buyuk tablolarda sayim ust sinirda durur ve 'en az' isaretlenir", async () => {
    const f = await getCatalogFunnel(db, admin, "hepsiburada", { countCap: 2 });
    expect(f.intake.total).toEqual({ value: 2, capped: true });
    expect(f.discovery.total).toEqual({ value: 2, capped: true });
    expect(f.intake.merged).toEqual({ value: 2, capped: false });
  });

  it("katalog yetkisi olmayan rol okuyamaz", async () => {
    await expect(
      getCatalogFunnel(db, { userId: admin.userId, role: "user" } as never, "hepsiburada"),
    ).rejects.toThrow();
  });

  it("stok bildirilmeyen teklif urun sayfasinda 'stokta yok' degil, bilinmiyor", async () => {
    const productId = await withOwnerClient(async (c) =>
      Number(
        (await c.query("SELECT id FROM product WHERE source_external_id = 'HBCVF1'")).rows[0].id,
      ),
    );
    const offers = await compareMerchants(db, productId);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ inStock: false, stockUnknown: true });
  });
});
