import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { compareMerchants } from "../search/compare-merchants.ts";
import { bestOfferCte } from "../search/search-sql.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { extractTrendyolPage } from "./extract-trendyol.ts";
import iphone from "./fixtures/iphone-857296094.json";
import listing from "./fixtures/listing-cat1.json";
import samba from "./fixtures/samba-813659620.json";
import {
  closeCollectionRun,
  getCollectionStatus,
  startCollectionRun,
  submitCollectionBatch,
} from "./service.ts";
import { loadTrendyolCatalogIds, sitemapCoverage } from "./trendyol-coverage.ts";
import { type CapturedPage, flushPendingListings, planRelayBatch } from "./trendyol-relay.ts";

/** Kayitli Trendyol sayfalari -> aktarim -> sunucu dogrulamasi -> ara depo (gercek Postgres). */
describe("Trendyol toplama servisi - entegrasyon (karar 0118)", () => {
  let db: Database;
  let admin: AdminActor;
  const suffix = Date.now();
  const flag = process.env.TRENDYOL_COLLECTION_ENABLED;

  async function reset() {
    await withOwnerClient(async (c) => {
      await c.query(
        "DELETE FROM catalog_intake_record WHERE run_id IN (SELECT id FROM collection_run WHERE source = 'trendyol')",
      );
      await c.query(
        "DELETE FROM collection_unit WHERE run_id IN (SELECT id FROM collection_run WHERE source = 'trendyol')",
      );
      await c.query("DELETE FROM collection_run WHERE source = 'trendyol'");
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const r = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`ty-collect-${suffix}@test.local`],
      );
      admin = { userId: Number(r.rows[0].id), role: "admin" };
    });
    await reset();
  });

  afterAll(async () => {
    process.env.TRENDYOL_COLLECTION_ENABLED = flag;
    await reset();
    await withOwnerClient(async (c) => {
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'trendyol'");
      await c.query("DELETE FROM admin_audit_event WHERE target_type = 'collection_run'");
      await c.query("DELETE FROM app_user WHERE email = $1", [`ty-collect-${suffix}@test.local`]);
    });
  });

  it("ortam bayragi kapaliyken kaynak yok sayilir (varsayilan)", async () => {
    delete process.env.TRENDYOL_COLLECTION_ENABLED;
    await expect(getCollectionStatus(db, admin, "trendyol")).rejects.toMatchObject({
      code: "unknown_source",
    });
  });

  it("bayrak acik ama veritabani politikasi kapali: kosu baslamaz", async () => {
    process.env.TRENDYOL_COLLECTION_ENABLED = "true";
    const status = await getCollectionStatus(db, admin, "trendyol");
    expect(status.quota).toMatchObject({
      enabled: false,
      blockedBy: "disabled",
      minIntervalDays: 7,
      maxRunsPerMonth: 4,
      permissionBasis: "written_email_reported",
    });
    await expect(startCollectionRun(db, admin, { source: "trendyol" })).rejects.toMatchObject({
      code: "collection_disabled",
    });
  });

  it("kayitli sayfalar ara depoya: satis fiyati, kosullu sepet fiyati, satici, varyant, tekillik", async () => {
    process.env.TRENDYOL_COLLECTION_ENABLED = "true";
    await withOwnerClient((c) =>
      c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'trendyol'"),
    );
    const run = await startCollectionRun(db, admin, { source: "trendyol" });
    const now = new Date();
    const captured: CapturedPage[] = [iphone, samba, listing].map((fx, i) => {
      const at = new Date(now.getTime() + i).toISOString();
      return {
        captureId: `capture-test-${i}`,
        url: fx.url,
        capturedAt: at,
        page: extractTrendyolPage({ ...fx, observedAt: at }),
      };
    });
    const state = {
      runId: run.id,
      requestsMade: run.requestsMade,
      maxRequests: run.maxRequests,
      processedCaptures: new Set<string>(),
      sentProducts: new Set<string>(),
    };
    const plan = planRelayBatch(state, captured);
    expect(plan.batch).not.toBeNull();
    const result = await submitCollectionBatch(db, admin, plan.batch as never, new Date());
    expect(result).toMatchObject({ inserted: 2, rejected: 0, duplicates: 0, requestsMade: 3 });
    // Liste kartlari kapanistan once gonderilir (istek sayilmaz).
    const pending = flushPendingListings(state);
    const listed = await submitCollectionBatch(db, admin, pending as never, new Date());
    expect(listed).toMatchObject({ inserted: 2, rejected: 0, requestsMade: 3 });

    await withOwnerClient(async (c) => {
      const rows = await c.query(
        `SELECT external_id, price_minor, basket_price_minor, list_price_minor, seller_external_id,
                seller_name, variant_external_id, variant_label, source_page, jsonb_array_length(image_urls) AS images
           FROM catalog_intake_record WHERE run_id = $1 ORDER BY external_id`,
        [run.id],
      );
      const byId = Object.fromEntries(rows.rows.map((r) => [r.external_id, r]));
      expect(byId["813659620"]).toMatchObject({
        price_minor: "799900",
        basket_price_minor: "399950",
        list_price_minor: null,
        seller_external_id: "106871",
        seller_name: "SuperStep",
        variant_label: "38",
        source_page: "product_page",
      });
      expect(byId["857296094"]).toMatchObject({
        price_minor: "12499900",
        list_price_minor: "12799900",
      });
      expect(byId["1198082362"]).toMatchObject({
        price_minor: "19389900",
        basket_price_minor: "19385900",
        seller_name: null,
        source_page: "listing_page",
      });
      const units = await c.query(
        "SELECT kind, count(*)::int AS n FROM collection_unit WHERE run_id = $1 GROUP BY kind ORDER BY kind",
        [run.id],
      );
      expect(units.rows).toEqual([
        { kind: "listing_page", n: 1 },
        { kind: "product_page", n: 2 },
      ]);
    });

    // Ayni kayitlarin yeniden gonderimi coğalmaz.
    const again = await submitCollectionBatch(
      db,
      admin,
      {
        ...(plan.batch as never as Record<string, unknown>),
        records: [...(plan.batch?.records ?? []), ...(pending?.records ?? [])],
        requestsMade: 3,
      } as never,
      new Date(),
    );
    expect(again).toMatchObject({ inserted: 0, duplicates: 4 });

    // Adres-kimlik tutarsizligi ve baska host gorseli sunucuda reddedilir.
    const bad = await submitCollectionBatch(
      db,
      admin,
      {
        runId: run.id,
        requestsMade: 3,
        units: [],
        records: [
          { ...(plan.batch?.records[0] as object), externalId: "1" },
          {
            ...(plan.batch?.records[0] as object),
            externalId: "999",
            url: "https://www.trendyol.com/a/b-p-999",
            imageUrls: ["https://evil.example/x.jpg"],
          },
        ],
      },
      new Date(),
    );
    expect(bad).toMatchObject({
      inserted: 0,
      rejected: 2,
      rejectedByCode: { url: 1, image_urls: 1 },
    });

    const report = await closeCollectionRun(db, admin, { runId: run.id, outcome: "completed" });
    expect(report).toMatchObject({ uniqueRecords: 4, productPages: 2, listingPages: 1 });
    // Ilk yukleme sinirsiz degil: kapanan kosudan sonra 7 gun dolmadan yenisi yok.
    await expect(startCollectionRun(db, admin, { source: "trendyol" })).rejects.toMatchObject({
      code: "collection_quota_interval",
    });
  });

  it("sitemap kimligi = offer.external_id: katalog kapsami tekrarsiz olculur", async () => {
    await withOwnerClient(async (c) => {
      await c.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active)
         VALUES ('trendyol', 'Trendyol', 'trendyol.com', 'user_discovered', TRUE)
         ON CONFLICT (slug) DO NOTHING`,
      );
      const m = await c.query("SELECT id FROM merchant WHERE slug = 'trendyol'");
      for (const id of ["813659620", "857296094", "1212864992"]) {
        await c.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, in_stock, attributes_raw)
           VALUES ($1, $2, $3, 'T', 100, TRUE, '{"stock_state":"unknown"}')`,
          [m.rows[0].id, id, `https://www.trendyol.com/x/t-p-${id}`],
        );
      }
    });
    try {
      const ids = await loadTrendyolCatalogIds(db);
      expect(new Set(ids).size).toBe(ids.length);
      const sitemap = Uint32Array.from([5999429, 813659620, 857296083, 857296094]);
      expect(sitemapCoverage(sitemap, ids)).toEqual({
        sitemapIds: 4,
        catalogIds: 3,
        inBoth: 2,
        catalogOnly: 1,
        coveragePct: 50,
      });
    } finally {
      await withOwnerClient(async (c) => {
        await c.query(
          "DELETE FROM offer WHERE merchant_id = (SELECT id FROM merchant WHERE slug = 'trendyol')",
        );
        await c.query("DELETE FROM merchant WHERE slug = 'trendyol'");
      });
    }
  });

  it("stok bilinmiyor: aramadan gizlenmez, 'stokta olanlar'a girmez, stok iddiasi yok", async () => {
    let productId = 0;
    await withOwnerClient(async (c) => {
      await c.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active)
         VALUES ('trendyol', 'Trendyol', 'trendyol.com', 'user_discovered', TRUE)
         ON CONFLICT (slug) DO NOTHING`,
      );
      const m = await c.query("SELECT id FROM merchant WHERE slug = 'trendyol'");
      const p = await c.query(
        `INSERT INTO product (slug, title, min_price, offer_count, in_stock_count)
         VALUES ($1, 'Stok bilinmeyen urun', 799900, 1, 0) RETURNING id`,
        [`ty-stock-${suffix}`],
      );
      productId = Number(p.rows[0].id);
      await c.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                            in_stock, attributes_raw)
         VALUES ($1, $2, '813659620', 'https://www.trendyol.com/adidas/samba-p-813659620', 'Samba',
                 799900, TRUE, '{"stock_state":"unknown"}')`,
        [m.rows[0].id, productId],
      );
    });
    try {
      const best = async (inStockOnly: boolean) =>
        (
          await db.execute(
            sql`WITH ${bestOfferCte(inStockOnly, null, productId)} SELECT offer_id FROM best_offer`,
          )
        ).rows.length;
      expect(await best(false)).toBe(1); // varsayilan arama: gizlenmez
      expect(await best(true)).toBe(0); // "stokta olanlar": dogrulanmamis stok sayilmaz
      const offers = await compareMerchants(db, productId);
      expect(offers).toEqual([
        expect.objectContaining({ currentPrice: 799900, inStock: true, stockKnown: false }),
      ]);
    } finally {
      await withOwnerClient(async (c) => {
        await c.query("DELETE FROM offer WHERE product_id = $1", [productId]);
        await c.query("DELETE FROM product WHERE id = $1", [productId]);
        await c.query("DELETE FROM merchant WHERE slug = 'trendyol'");
      });
    }
  });
});
