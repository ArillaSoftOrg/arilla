import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { OfferNotFoundError, recordClick } from "./record-click.ts";

let sessionSeq = 0;
// Ayni ms icinde iki cagri dedupe penceresine takilmasin diye her cagri ayri oturum.
const uniqueSession = () => `c3-test-session-${Date.now()}-${++sessionSeq}`;

describe("recordClick() - integration (real seeded Postgres)", () => {
  let db: Database;
  const createdClickIds: string[] = [];

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    if (createdClickIds.length === 0) return;
    await withOwnerClient(async (client) => {
      for (const clickId of createdClickIds) {
        await client.query("DELETE FROM click WHERE id = $1", [clickId]);
      }
    });
  });

  describe("gerçek seed veri (aktif merchant, creator yok)", () => {
    let offerId = 0;
    let offerUrl = "";

    beforeAll(async () => {
      const row = await withOwnerClient(async (client) => {
        // ORDER BY o.id ASC: diger entegrasyon test dosyalari (search/,
        // compare-merchants) ayni suite calisirken sentetik merchant/offer
        // fixture'lari ekleyebiliyor - ORDER BY olmadan bu sorgu bazen o
        // taze eklenen fixture'i secip, o testin kendi cleanup'inda FK
        // ihlaline yol aciyordu. En kucuk id her zaman gercek seed verisi.
        const result = await client.query(
          `SELECT o.id, o.url FROM offer o
           JOIN merchant m ON m.id = o.merchant_id
           WHERE m.affiliate_status = 'active' AND o.is_active
           ORDER BY o.id ASC LIMIT 1`,
        );
        return result.rows[0];
      });
      offerId = Number(row.id);
      offerUrl = row.url;
    });

    it("produces a tracked redirect URL containing the generated click_id", async () => {
      const result = await recordClick(db, {
        offerId,
        sessionId: uniqueSession(),
        channel: "web",
      });
      createdClickIds.push(result.clickId);

      expect(result.redirectUrl).toContain(encodeURIComponent(result.clickId));
      expect(result.redirectUrl).toContain(encodeURIComponent(offerUrl));
      expect(result.redirectUrl).not.toBe(offerUrl);
    });

    it("persists a click row with the right fields", async () => {
      const sessionId = uniqueSession();
      const result = await recordClick(db, {
        offerId,
        sessionId,
        channel: "mcp",
        surface: "compare",
      });
      createdClickIds.push(result.clickId);

      const row = await withOwnerClient(async (client) => {
        const res = await client.query("SELECT * FROM click WHERE id = $1", [result.clickId]);
        return res.rows[0];
      });

      expect(row.offer_id).toBe(String(offerId));
      expect(row.session_id).toBe(sessionId);
      expect(row.channel).toBe("mcp");
      expect(row.surface).toBe("compare");
      expect(row.price_at_click).not.toBeNull();
    });

    it("fills product_id from the offer, never from input", async () => {
      const result = await recordClick(db, { offerId, sessionId: uniqueSession(), channel: "web" });
      createdClickIds.push(result.clickId);
      const { rows } = await withOwnerClient(async (client) => ({
        rows: [
          (await client.query("SELECT product_id FROM click WHERE id = $1", [result.clickId]))
            .rows[0],
          (await client.query("SELECT product_id FROM offer WHERE id = $1", [offerId])).rows[0],
        ],
      }));
      expect(rows[0].product_id).toBe(rows[1].product_id);
    });

    it("reuses the click row for a repeat within the dedupe window", async () => {
      const sessionId = uniqueSession();
      const first = await recordClick(db, { offerId, sessionId, channel: "web" });
      createdClickIds.push(first.clickId);
      const second = await recordClick(db, { offerId, sessionId, channel: "web" });
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.clickId).toBe(first.clickId);
    });

    it("writes a single row for simultaneous clicks on the same session+offer", async () => {
      const sessionId = uniqueSession();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => recordClick(db, { offerId, sessionId, channel: "web" })),
      );
      createdClickIds.push(results[0]?.clickId ?? "");
      expect(new Set(results.map((r) => r.clickId)).size).toBe(1);
      expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
      const count = await withOwnerClient(
        async (client) =>
          (
            await client.query("SELECT count(*)::int AS n FROM click WHERE session_id = $1", [
              sessionId,
            ])
          ).rows[0].n,
      );
      expect(count).toBe(1);
    });

    it("does not dedupe across sessions", async () => {
      const a = await recordClick(db, { offerId, sessionId: uniqueSession(), channel: "web" });
      const b = await recordClick(db, { offerId, sessionId: uniqueSession(), channel: "web" });
      createdClickIds.push(a.clickId, b.clickId);
      expect(b.clickId).not.toBe(a.clickId);
    });

    it("drops an out-of-range resultPosition instead of writing it", async () => {
      const result = await recordClick(db, {
        offerId,
        sessionId: uniqueSession(),
        channel: "web",
        resultPosition: 99999,
      });
      createdClickIds.push(result.clickId);
      const row = await withOwnerClient(
        async (client) =>
          (await client.query("SELECT result_position FROM click WHERE id = $1", [result.clickId]))
            .rows[0],
      );
      expect(row.result_position).toBeNull();
    });

    it("round-trips sourceSimilarityKind and resultPosition when provided", async () => {
      const withFields = await recordClick(db, {
        offerId,
        sessionId: uniqueSession(),
        channel: "web",
        sourceSimilarityKind: "visual",
        resultPosition: 2,
      });
      createdClickIds.push(withFields.clickId);

      const withoutFields = await recordClick(db, {
        offerId,
        sessionId: uniqueSession(),
        channel: "web",
      });
      createdClickIds.push(withoutFields.clickId);

      const rows = await withOwnerClient(async (client) => {
        const res = await client.query(
          "SELECT id, source_similarity_kind, result_position FROM click WHERE id = ANY($1)",
          [[withFields.clickId, withoutFields.clickId]],
        );
        return res.rows;
      });

      const withRow = rows.find((r) => r.id === withFields.clickId);
      const withoutRow = rows.find((r) => r.id === withoutFields.clickId);

      expect(withRow.source_similarity_kind).toBe("visual");
      expect(withRow.result_position).toBe(2);
      expect(withoutRow.source_similarity_kind).toBeNull();
      expect(withoutRow.result_position).toBeNull();
    });

    it("throws OfferNotFoundError for a nonexistent offer", async () => {
      await expect(
        recordClick(db, { offerId: 999_999_999, sessionId: "s", channel: "web" }),
      ).rejects.toBeInstanceOf(OfferNotFoundError);
    });
  });

  describe("sentetik creator-tracking fixture (seed'de creator/creator_affiliate_account yok)", () => {
    const suffix = Date.now();
    let merchantId = 0;
    let offerId = 0;
    let creatorWithAccountId = 0;
    let creatorWithoutAccountId = 0;

    beforeAll(async () => {
      await withOwnerClient(async (client) => {
        const merchantResult = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, affiliate_status, affiliate_network, deeplink_template)
           VALUES ($1, 'C3 Test Merchant', $2, 'affiliate_network', 'active', 'ornek-ag',
             'https://c3-fixture.test/git?u={url}&ref={click_id}&t={tracking_id}')
           RETURNING id`,
          [`c3-test-merchant-${suffix}`, `c3-test-merchant-${suffix}.test`],
        );
        merchantId = Number(merchantResult.rows[0].id);

        const offerResult = await client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, is_active, in_stock)
           VALUES ($1, $2, 'https://c3-fixture.test/p/1', 'C3 Test Urunu', 100000, true, true)
           RETURNING id`,
          [merchantId, `c3-test-offer-${suffix}`],
        );
        offerId = Number(offerResult.rows[0].id);

        const userWithAccount = await client.query(
          `INSERT INTO app_user (email, display_name, role) VALUES ($1, 'C3 Creator A', 'creator') RETURNING id`,
          [`c3-test-creator-a-${suffix}@example.test`],
        );
        const creatorWithAccountResult = await client.query(
          `INSERT INTO creator (user_id, handle, display_name) VALUES ($1, $2, 'C3 Creator A') RETURNING id`,
          [Number(userWithAccount.rows[0].id), `c3-test-creator-a-${suffix}`],
        );
        creatorWithAccountId = Number(creatorWithAccountResult.rows[0].id);

        await client.query(
          `INSERT INTO creator_affiliate_account (creator_id, merchant_id, tracking_id, status)
           VALUES ($1, $2, 'creator-a-tracking-id', 'active')`,
          [creatorWithAccountId, merchantId],
        );

        const userWithoutAccount = await client.query(
          `INSERT INTO app_user (email, display_name, role) VALUES ($1, 'C3 Creator B', 'creator') RETURNING id`,
          [`c3-test-creator-b-${suffix}@example.test`],
        );
        const creatorWithoutAccountResult = await client.query(
          `INSERT INTO creator (user_id, handle, display_name) VALUES ($1, $2, 'C3 Creator B') RETURNING id`,
          [Number(userWithoutAccount.rows[0].id), `c3-test-creator-b-${suffix}`],
        );
        creatorWithoutAccountId = Number(creatorWithoutAccountResult.rows[0].id);
      });
    });

    afterAll(async () => {
      await withOwnerClient(async (client) => {
        await client.query("DELETE FROM click WHERE offer_id = $1", [offerId]);
        await client.query("DELETE FROM creator_affiliate_account WHERE merchant_id = $1", [
          merchantId,
        ]);
        await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
        await client.query("DELETE FROM creator WHERE id = ANY($1)", [
          [creatorWithAccountId, creatorWithoutAccountId],
        ]);
        await client.query("DELETE FROM app_user WHERE email LIKE $1", [
          `c3-test-creator-%-${suffix}@%`,
        ]);
        await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      });
    });

    it("embeds the creator's own tracking id when an active account exists (Model A)", async () => {
      const result = await recordClick(db, {
        offerId,
        sessionId: `c3-test-session-${suffix}-a`,
        channel: "web",
        creatorId: creatorWithAccountId,
      });
      createdClickIds.push(result.clickId);

      expect(result.redirectUrl).toContain("t=creator-a-tracking-id");
    });

    it("resolves tracking_id to empty when the creator has no active account for this merchant", async () => {
      const result = await recordClick(db, {
        offerId,
        sessionId: `c3-test-session-${suffix}-b`,
        channel: "web",
        creatorId: creatorWithoutAccountId,
      });
      createdClickIds.push(result.clickId);

      expect(result.redirectUrl).toContain("t=");
      expect(result.redirectUrl).not.toContain("t=creator-a-tracking-id");
      expect(result.redirectUrl).not.toContain("{tracking_id}");
    });
  });
});
