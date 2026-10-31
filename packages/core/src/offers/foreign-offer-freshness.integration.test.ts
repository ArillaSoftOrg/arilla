/**
 * Yurt dışı teklif: son fiyat kaydı ile kaynak doğrulamasının ayrılması ve USD fiyat geçmişi.
 * Gerçek (yalıtılmış) Postgres. Politika (`config.freshness`) KAPALIDIR: eski teklif gizlenmez,
 * yalnızca güncel diye sunulmaz. Yalnızca kendi `suffix` verisini yazar ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getForeignPriceHistory, getPriceHistory } from "../product/get-price-history.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getProductForeignOffers } from "./product-foreign-offers.ts";

const suffix = `ff-${Date.now().toString(36)}`;
const day = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * day).toISOString();

describe("yurt dışı teklif: kaynak durumu ve fiyat geçmişi", () => {
  let db: Database;
  let merchantId = 0;
  let feedId = 0;
  let productId = 0;
  let tryProductId = 0;
  const offers: Record<string, number> = {};

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active, trust_score)
         VALUES ($1, 'Yurt Disi Test', $2, 'affiliate_network', TRUE, 80) RETURNING id`,
        [`ff-${suffix}`, `${suffix}.example.test`],
      );
      merchantId = Number(m.rows[0].id);
      const f = await client.query(
        `INSERT INTO feed_source (network, external_id, merchant_id, status, config, last_success_at)
         VALUES ('testforeign', $1, $2, 'active', '{}'::jsonb, $3) RETURNING id`,
        [`${suffix}:feed`, merchantId, ago(0.1)],
      );
      feedId = Number(f.rows[0].id);
      const snap = async (when: string): Promise<number> => {
        const r = await client.query(
          `INSERT INTO source_snapshot (feed_source_id, status, started_at, completed_at)
           VALUES ($1, 'complete', $2, $2) RETURNING id`,
          [feedId, when],
        );
        return Number(r.rows[0].id);
      };
      const oldSnap = await snap(ago(6));
      const latestSnap = await snap(ago(0.2));
      // Başarısız (tamamlanmamış) sürüm "son sürüm" sayılmaz.
      await client.query(
        `INSERT INTO source_snapshot (feed_source_id, status, started_at)
         VALUES ($1, 'rejected', now())`,
        [feedId],
      );

      const p = async (key: string): Promise<number> => {
        const r = await client.query(
          "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
          [`${key}-${suffix}`, `${key} ${suffix}`],
        );
        return Number(r.rows[0].id);
      };
      productId = await p("usd");
      tryProductId = await p("try");

      const offer = async (
        key: string,
        currency: string,
        price: number,
        product: number,
        membership?: { snapshotId: number; seen: string },
      ): Promise<void> => {
        const r = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price,
                              currency, is_active, in_stock, feed_source_id, last_seen_at)
           VALUES ($1, $2, $3, $4, $3, $5, $6, TRUE, TRUE, $7, $8) RETURNING id`,
          [
            merchantId,
            product,
            `${key}-${suffix}`,
            `https://${suffix}.example.test/${key}`,
            price,
            currency,
            membership ? feedId : null,
            membership?.seen ?? ago(30),
          ],
        );
        offers[key] = Number(r.rows[0].id);
        if (membership) {
          await client.query(
            `INSERT INTO feed_source_offer
               (feed_source_id, offer_id, last_snapshot_id, first_seen_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $4)`,
            [feedId, offers[key], membership.snapshotId, membership.seen],
          );
        }
      };
      await offer("current", "USD", 1500, productId, { snapshotId: latestSnap, seen: ago(0.3) });
      await offer("old", "USD", 900, productId, { snapshotId: oldSnap, seen: ago(6) });
      await offer("nomember", "USD", 700, productId);
      await offer("try", "TRY", 25000, tryProductId);

      const point = (key: string, daysBack: number, price: number) =>
        client.query(
          "INSERT INTO price_point (offer_id, observed_at, price, in_stock) VALUES ($1, $2, $3, true)",
          [offers[key], ago(daysBack), price],
        );
      await point("current", 20, 1800);
      await point("current", 10, 1600);
      await point("current", 2, 1500);
      // Aynı gün iki kayıt: günlük en düşük alınır.
      await point("old", 2.1, 950);
      await point("old", 2, 900);
      await point("try", 3, 25000);
      await point("try", 1, 24000);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      const ids = Object.values(offers);
      await client.query("DELETE FROM price_point WHERE offer_id = ANY($1)", [ids]);
      await client.query("DELETE FROM feed_source_offer WHERE feed_source_id = $1", [feedId]);
      await client.query("UPDATE offer SET product_id = NULL WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [[productId, tryProductId]]);
      await client.query("DELETE FROM source_snapshot WHERE feed_source_id = $1", [feedId]);
      await client.query("DELETE FROM feed_source WHERE id = $1", [feedId]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    });
  });

  it("kaynağın son sürümündeki teklif güncel, eski sürümdeki güncel değil, üyeliksiz bilinmiyor", async () => {
    const foreign = await getProductForeignOffers(db, productId);
    const status = new Map(foreign.map((f) => [f.offerId, f.sourceStatus]));
    expect(status.get(offers.current as number)).toBe("current");
    expect(status.get(offers.old as number)).toBe("not_current");
    expect(status.get(offers.nomember as number)).toBe("unknown");
  });

  it("eski teklif gizlenmez (politika kapalı); son fiyat kaydı ile kaynakta görülme ayrıdır", async () => {
    const foreign = await getProductForeignOffers(db, productId);
    const old = foreign.find((f) => f.offerId === offers.old);
    expect(old).toBeDefined();
    expect(old?.priceMinor).toBe(900);
    expect(old?.priceChangedAt?.getTime()).toBeLessThan(Date.now() - 1.9 * day);
    expect(old?.lastSeenAt.getTime()).toBeLessThan(Date.now() - 5.9 * day);
    // Fiyat kaydı olmayan teklifte son fiyat kaydı yok; kaynak görülmesi son görülmedir.
    const nomember = foreign.find((f) => f.offerId === offers.nomember);
    expect(nomember?.priceChangedAt).toBeNull();
  });

  it("USD fiyat geçmişi kendi para biriminde, günlük en düşükle döner; TL geçmişine karışmaz", async () => {
    const history = await getForeignPriceHistory(db, productId, "USD");
    expect(history.currency).toBe("USD");
    // 3 farklı gün: 20, 10 ve 2 gün önce (2 gün önceki iki teklif de dahil, en düşük 900).
    expect(history.points.map((x) => x.minPriceKurus)).toEqual([1800, 1600, 900]);
    expect(await getPriceHistory(db, productId)).toEqual([]);
    expect(await getForeignPriceHistory(db, productId, "TRY")).toEqual({
      currency: "TRY",
      points: [],
    });
    // TRY ürünün geçmişi yurt dışı sorgusuna girmez.
    expect((await getForeignPriceHistory(db, tryProductId, "USD")).points).toEqual([]);
    expect((await getPriceHistory(db, tryProductId)).map((x) => x.minPriceKurus)).toEqual([
      25000, 24000,
    ]);
  });
});
