import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { OfferNotFoundError, recordClick } from "./record-click.ts";

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
        sessionId: `c3-test-session-${Date.now()}`,
        channel: "web",
      });
      createdClickIds.push(result.clickId);

      expect(result.redirectUrl).toContain(encodeURIComponent(result.clickId));
      expect(result.redirectUrl).toContain(encodeURIComponent(offerUrl));
      expect(result.redirectUrl).not.toBe(offerUrl);
    });

    it("persists a click row with the right fields", async () => {
      const sessionId = `c3-test-session-${Date.now()}`;
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

    it("round-trips sourceSimilarityKind and resultPosition when provided", async () => {
      const withFields = await recordClick(db, {
        offerId,
        sessionId: `c3-test-session-${Date.now()}`,
        channel: "web",
        sourceSimilarityKind: "visual",
        resultPosition: 2,
      });
      createdClickIds.push(withFields.clickId);

      const withoutFields = await recordClick(db, {
        offerId,
        sessionId: `c3-test-session-${Date.now()}`,
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
