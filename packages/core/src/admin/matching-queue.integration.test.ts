import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { approveMatch, listMatchQueue, rejectMatch } from "./matching-queue.ts";

describe("eşleştirme kuyruğu - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let merchantId = 0;
  let brandId = 0;
  let lowScoreOfferId = 0;
  let highScoreOfferId = 0;
  let rejectOfferId = 0;
  let lowScoreProductId = 0;
  let highScoreProductId = 0;
  let rejectProductId = 0;
  let lowScoreCandidateId = 0;
  let highScoreCandidateId = 0;
  let rejectCandidateId = 0;
  let alreadyDecidedCandidateId = 0;

  beforeAll(async () => {
    db = getTestDb();

    await withOwnerClient(async (client) => {
      const merchantResult = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Admin Queue Test Merchant', $2, 'xml_feed') RETURNING id`,
        [`admin-queue-merchant-${suffix}`, `admin-queue-${suffix}.test`],
      );
      merchantId = Number(merchantResult.rows[0].id);

      const brandResult = await client.query(
        `INSERT INTO brand (slug, name, name_norm) VALUES ($1, 'Admin Queue Marka', 'admin queue marka')
         RETURNING id`,
        [`admin-queue-brand-${suffix}`],
      );
      brandId = Number(brandResult.rows[0].id);

      const makeProduct = async (title: string) => {
        const result = await client.query(
          `INSERT INTO product (slug, title, brand_id, primary_image_url)
           VALUES ($1, $2, $3, 'https://admin-queue.test/product.jpg') RETURNING id`,
          [`admin-queue-${title}-${suffix}`, title, brandId],
        );
        return Number(result.rows[0].id);
      };
      lowScoreProductId = await makeProduct("dusuk-skor-urun");
      highScoreProductId = await makeProduct("yuksek-skor-urun");
      rejectProductId = await makeProduct("red-urun");

      const makeOffer = async (externalId: string) => {
        const result = await client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, brand_raw, image_url)
           VALUES ($1, $2, $3, 'Admin Queue Teklif', 'Admin Queue Marka', 'https://admin-queue.test/offer.jpg')
           RETURNING id`,
          [merchantId, externalId, `https://admin-queue.test/${externalId}`],
        );
        return Number(result.rows[0].id);
      };
      lowScoreOfferId = await makeOffer(`low-${suffix}`);
      highScoreOfferId = await makeOffer(`high-${suffix}`);
      rejectOfferId = await makeOffer(`reject-${suffix}`);

      const makeCandidate = async (offerId: number, productId: number, score: number) => {
        const result = await client.query(
          `INSERT INTO match_candidate (offer_id, product_id, score, method, status)
           VALUES ($1, $2, $3, 'text', 'pending') RETURNING id`,
          [offerId, productId, score],
        );
        return Number(result.rows[0].id);
      };
      lowScoreCandidateId = await makeCandidate(lowScoreOfferId, lowScoreProductId, 0.65);
      highScoreCandidateId = await makeCandidate(highScoreOfferId, highScoreProductId, 0.8);
      rejectCandidateId = await makeCandidate(rejectOfferId, rejectProductId, 0.7);

      const decidedResult = await client.query(
        `INSERT INTO match_candidate (offer_id, product_id, score, method, status)
         VALUES ($1, $2, 0.75, 'text', 'accepted') RETURNING id`,
        [rejectOfferId, lowScoreProductId],
      );
      alreadyDecidedCandidateId = Number(decidedResult.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM match_candidate WHERE offer_id = ANY($1)", [
        [lowScoreOfferId, highScoreOfferId, rejectOfferId],
      ]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [
        [lowScoreProductId, highScoreProductId, rejectProductId],
      ]);
      await client.query("DELETE FROM brand WHERE id = $1", [brandId]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    });
  });

  it("yalnızca pending satırları, skor artan sırada (en belirsiz önce) döner", async () => {
    const items = await listMatchQueue(db, 200);
    const ours = items.filter((item) =>
      [lowScoreCandidateId, highScoreCandidateId, rejectCandidateId].includes(
        item.matchCandidateId,
      ),
    );

    expect(ours.map((item) => item.matchCandidateId)).toEqual([
      lowScoreCandidateId,
      rejectCandidateId,
      highScoreCandidateId,
    ]);
    expect(ours.some((item) => item.matchCandidateId === alreadyDecidedCandidateId)).toBe(false);

    const low = ours.find((item) => item.matchCandidateId === lowScoreCandidateId);
    expect(low?.offer.title).toBe("Admin Queue Teklif");
    expect(low?.offer.brand).toBe("Admin Queue Marka");
    expect(low?.product.brand).toBe("Admin Queue Marka");
    expect(low?.method).toBe("text");
  });

  it("approveMatch: durumu 'accepted' yapar ve offer.product_id'yi bağlar", async () => {
    const result = await approveMatch(db, highScoreCandidateId);
    expect(result.found).toBe(true);

    const row = await withOwnerClient(async (client) => {
      const res = await client.query(
        "SELECT status, reviewed_at FROM match_candidate WHERE id = $1",
        [highScoreCandidateId],
      );
      return res.rows[0];
    });
    expect(row.status).toBe("accepted");
    expect(row.reviewed_at).not.toBeNull();

    const offerRow = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT product_id FROM offer WHERE id = $1", [
        highScoreOfferId,
      ]);
      return res.rows[0];
    });
    expect(Number(offerRow.product_id)).toBe(highScoreProductId);
  });

  it("rejectMatch: durumu 'rejected' yapar ama offer.product_id'ye dokunmaz", async () => {
    const result = await rejectMatch(db, rejectCandidateId);
    expect(result.found).toBe(true);

    const row = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT status FROM match_candidate WHERE id = $1", [
        rejectCandidateId,
      ]);
      return res.rows[0];
    });
    expect(row.status).toBe("rejected");

    const offerRow = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT product_id FROM offer WHERE id = $1", [
        rejectOfferId,
      ]);
      return res.rows[0];
    });
    expect(offerRow.product_id).toBeNull();
  });

  it("zaten karara bağlanmış bir satır üzerinde found:false döner", async () => {
    const result = await approveMatch(db, alreadyDecidedCandidateId);
    expect(result.found).toBe(false);
  });

  it("var olmayan bir id için found:false döner", async () => {
    const result = await rejectMatch(db, 999_999_999);
    expect(result.found).toBe(false);
  });
});
