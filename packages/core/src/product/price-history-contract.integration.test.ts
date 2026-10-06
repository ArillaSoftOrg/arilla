import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getPriceHistory } from "./get-price-history.ts";
import { type OfferPriceDayRow, offerPriceDaysSql } from "./offer-price-days.ts";

/**
 * Sozlesme (docs/decisions/0065): `price_point` = fiyat DEGISIM olayi,
 * `offer.last_seen_at` = tazelik. Gunluk seri ikisinden turetilir.
 */
const SLUG = "test-price-contract";
const DOMAIN = "test-price-contract.example";

describe("price_point change-event contract - integration (real Postgres)", () => {
  let db: Database;
  let merchantId = 0;
  const created: { productIds: number[]; offerIds: number[] } = { productIds: [], offerIds: [] };

  async function makeOffer(
    key: string,
    opts: { events: [daysAgo: number, price: number][]; lastSeenDaysAgo: number },
  ): Promise<{ productId: number; offerId: number }> {
    return withOwnerClient(async (client) => {
      const product = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, $2) RETURNING id",
        [`${SLUG}-${key}`, `Sozlesme ${key}`],
      );
      const productId = Number(product.rows[0].id);
      const offer = await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                            current_price, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, 1000, now() - make_interval(days => $6))
         RETURNING id`,
        [
          merchantId,
          productId,
          `${SLUG}-${key}`,
          `https://${DOMAIN}/${key}`,
          `Sozlesme ${key}`,
          opts.lastSeenDaysAgo,
        ],
      );
      const offerId = Number(offer.rows[0].id);
      for (const [daysAgo, price] of opts.events) {
        await client.query(
          `INSERT INTO price_point (offer_id, observed_at, price, in_stock)
           VALUES ($1, now() - make_interval(days => $2) + interval '1 hour', $3, TRUE)`,
          [offerId, daysAgo, price],
        );
      }
      created.productIds.push(productId);
      created.offerIds.push(offerId);
      return { productId, offerId };
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      await client.query(
        `DELETE FROM price_point WHERE offer_id IN (
           SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = $1)`,
        [DOMAIN],
      );
      await client.query(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = $1)",
        [DOMAIN],
      );
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`${SLUG}-%`]);
      await client.query("DELETE FROM merchant WHERE domain = $1", [DOMAIN]);
      const merchant = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Test Price Contract', $2, 'user_discovered') RETURNING id`,
        [SLUG, DOMAIN],
      );
      merchantId = Number(merchant.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM price_point WHERE offer_id = ANY($1::bigint[])", [
        created.offerIds,
      ]);
      await client.query("DELETE FROM offer WHERE id = ANY($1::bigint[])", [created.offerIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1::bigint[])", [created.productIds]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    });
  });

  it("history shows each price change once and carries the price between events", async () => {
    // 10 gun once 1000, 4 gun once 800'e dustu; bugun goruldu.
    const { productId } = await makeOffer("change", {
      events: [
        [10, 1000],
        [4, 800],
      ],
      lastSeenDaysAgo: 0,
    });

    const history = await getPriceHistory(db, productId, 30);

    expect(history.length).toBeGreaterThanOrEqual(10);
    expect(history[0]?.minPriceKurus).toBe(1000);
    expect(history.at(-1)?.minPriceKurus).toBe(800);
    const changes = history.filter(
      (point, i) => i > 0 && point.minPriceKurus !== history[i - 1]?.minPriceKurus,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.minPriceKurus).toBe(800);
  });

  it("an unchanged price is a flat series up to last_seen_at (no new price_point needed)", async () => {
    // Tek olay 20 gun once; sonra hic yeni price_point yok ama teklif bugun goruldu.
    const { productId, offerId } = await makeOffer("flat", {
      events: [[20, 700]],
      lastSeenDaysAgo: 0,
    });

    const history = await getPriceHistory(db, productId, 90);

    expect(history.length).toBeGreaterThanOrEqual(20);
    expect(new Set(history.map((point) => point.minPriceKurus))).toEqual(new Set([700]));
    const count = await withOwnerClient((client) =>
      client.query("SELECT count(*) FROM price_point WHERE offer_id = $1", [offerId]),
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("the series ends at last_seen_at: a vanished offer is not 'seen' afterwards", async () => {
    const { productId } = await makeOffer("vanished", {
      events: [[20, 500]],
      lastSeenDaysAgo: 12,
    });

    const history = await getPriceHistory(db, productId, 90);

    const last = history.at(-1);
    expect(last).toBeDefined();
    const lastDay = new Date(`${last?.date}T00:00:00Z`).getTime();
    const daysSince = (Date.now() - lastDay) / 86_400_000;
    expect(daysSince).toBeGreaterThanOrEqual(11);
    expect(daysSince).toBeLessThan(14);
  });

  it("offer days (used by variant history) come from events plus last_seen_at", async () => {
    const { offerId } = await makeOffer("days", {
      events: [
        [6, 900],
        [2, 650],
      ],
      lastSeenDaysAgo: 0,
    });

    const result = await db.execute<OfferPriceDayRow>(
      offerPriceDaysSql(sql`SELECT ${offerId}::bigint AS id`, 30),
    );
    const days = result.rows.map((row) => ({ day: row.day, price: Number(row.min_price) }));

    expect(days.length).toBeGreaterThanOrEqual(6);
    expect(days[0]?.price).toBe(900);
    expect(days.at(-1)?.price).toBe(650);
    // Olaylar arasi gunler de var: yalnizca 2 satir (olay gunleri) degil.
    expect(days.length).toBeGreaterThan(2);
  });
});
