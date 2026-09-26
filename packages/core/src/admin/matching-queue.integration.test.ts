import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  approveMatch,
  countPendingMatches,
  listMatchQueue,
  rejectMatch,
} from "./matching-queue.ts";

describe("eşleştirme kuyruğu - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let merchantId = 0;
  let brandId = 0;
  let moderator: AdminActor;
  const offerIds: number[] = [];
  const productIds: number[] = [];

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

  // Aynı teklif için iki pending aday (kardeşler).
  let siblingOfferId = 0;
  let siblingWinnerId = 0;
  let siblingLoserId = 0;

  // Teklif başka bir ürüne zaten bağlı.
  let linkedOfferId = 0;
  let linkedCandidateId = 0;
  let linkedToProductId = 0;

  const offerProductId = (offerId: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query("SELECT product_id FROM offer WHERE id = $1", [offerId]);
      const value = res.rows[0].product_id;
      return value === null ? null : Number(value);
    });

  const candidate = (id: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        "SELECT status, reviewed_at, reviewed_by FROM match_candidate WHERE id = $1",
        [id],
      );
      return res.rows[0];
    });

  const auditRows = (candidateId: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT actor_user_id, actor_role, action, before, after FROM admin_audit_event
          WHERE target_type = 'match_candidate' AND target_id = $1 ORDER BY id`,
        [String(candidateId)],
      );
      return res.rows;
    });

  beforeAll(async () => {
    db = getTestDb();

    await withOwnerClient(async (client) => {
      const userResult = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`admin-queue-mod-${suffix}@test.local`],
      );
      moderator = { userId: Number(userResult.rows[0].id), role: "moderator" };

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
        const id = Number(result.rows[0].id);
        productIds.push(id);
        return id;
      };
      lowScoreProductId = await makeProduct("dusuk-skor-urun");
      highScoreProductId = await makeProduct("yuksek-skor-urun");
      rejectProductId = await makeProduct("red-urun");
      const siblingProductA = await makeProduct("kardes-a");
      const siblingProductB = await makeProduct("kardes-b");
      linkedToProductId = await makeProduct("bagli-urun");
      const linkedCandidateProduct = await makeProduct("bagli-aday");

      const makeOffer = async (externalId: string, productId: number | null = null) => {
        const result = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, brand_raw, image_url)
           VALUES ($1, $2, $3, $4, 'Admin Queue Teklif', 'Admin Queue Marka', 'https://admin-queue.test/offer.jpg')
           RETURNING id`,
          [merchantId, productId, externalId, `https://admin-queue.test/${externalId}`],
        );
        const id = Number(result.rows[0].id);
        offerIds.push(id);
        return id;
      };
      lowScoreOfferId = await makeOffer(`low-${suffix}`);
      highScoreOfferId = await makeOffer(`high-${suffix}`);
      rejectOfferId = await makeOffer(`reject-${suffix}`);
      siblingOfferId = await makeOffer(`sibling-${suffix}`);
      linkedOfferId = await makeOffer(`linked-${suffix}`, linkedToProductId);

      const makeCandidate = async (
        offerId: number,
        productId: number,
        score: number,
        status = "pending",
      ) => {
        const result = await client.query(
          `INSERT INTO match_candidate (offer_id, product_id, score, method, status)
           VALUES ($1, $2, $3, 'text', $4) RETURNING id`,
          [offerId, productId, score, status],
        );
        return Number(result.rows[0].id);
      };
      lowScoreCandidateId = await makeCandidate(lowScoreOfferId, lowScoreProductId, 0.65);
      highScoreCandidateId = await makeCandidate(highScoreOfferId, highScoreProductId, 0.8);
      rejectCandidateId = await makeCandidate(rejectOfferId, rejectProductId, 0.7);
      alreadyDecidedCandidateId = await makeCandidate(
        rejectOfferId,
        lowScoreProductId,
        0.75,
        "accepted",
      );
      siblingWinnerId = await makeCandidate(siblingOfferId, siblingProductA, 0.7);
      siblingLoserId = await makeCandidate(siblingOfferId, siblingProductB, 0.68);
      linkedCandidateId = await makeCandidate(linkedOfferId, linkedCandidateProduct, 0.7);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = $1", [
        moderator.userId,
      ]);
      await client.query("DELETE FROM match_candidate WHERE offer_id = ANY($1)", [offerIds]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
      await client.query("DELETE FROM brand WHERE id = $1", [brandId]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [moderator.userId]);
    });
  });

  it("yalnızca pending satırları, skor artan sırada (en belirsiz önce) döner", async () => {
    const items = await listMatchQueue(db, 500);
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
    expect(items.some((item) => item.matchCandidateId === alreadyDecidedCandidateId)).toBe(false);

    const low = ours.find((item) => item.matchCandidateId === lowScoreCandidateId);
    expect(low?.offer.title).toBe("Admin Queue Teklif");
    expect(low?.offer.brand).toBe("Admin Queue Marka");
    expect(low?.product.brand).toBe("Admin Queue Marka");
    expect(low?.method).toBe("text");
  });

  it("countPendingMatches grup boyutunu değil gerçek toplamı sayar", async () => {
    const total = await countPendingMatches(db);
    // Bu testin 6 pending satırı en az bu kadar sayılmalı; paylaşılan DB'de fazlası olabilir.
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it("yetkisiz aktör: hiçbir şey değişmez, AdminForbiddenError", async () => {
    const user: AdminActor = { userId: moderator.userId, role: "user" };
    await expect(approveMatch(db, user, lowScoreCandidateId)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(rejectMatch(db, user, lowScoreCandidateId)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    expect((await candidate(lowScoreCandidateId)).status).toBe("pending");
    expect(await auditRows(lowScoreCandidateId)).toHaveLength(0);
  });

  it("approveMatch: accepted + reviewed_by + offer.product_id + tek denetim kaydı", async () => {
    const result = await approveMatch(db, moderator, highScoreCandidateId);
    expect(result).toEqual({ found: true });

    const row = await candidate(highScoreCandidateId);
    expect(row.status).toBe("accepted");
    expect(row.reviewed_at).not.toBeNull();
    expect(Number(row.reviewed_by)).toBe(moderator.userId);
    expect(await offerProductId(highScoreOfferId)).toBe(highScoreProductId);

    const audit = await auditRows(highScoreCandidateId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("matching.approve");
    expect(audit[0].actor_role).toBe("moderator");
    expect(Number(audit[0].actor_user_id)).toBe(moderator.userId);
    expect(audit[0].after.productId).toBe(highScoreProductId);
  });

  it("aynı satırı ikinci kez onaylamak found:false döner, ikinci denetim kaydı yazılmaz", async () => {
    const result = await approveMatch(db, moderator, highScoreCandidateId);
    expect(result.found).toBe(false);
    expect(await auditRows(highScoreCandidateId)).toHaveLength(1);
  });

  it("approveMatch: aynı teklifin diğer pending adayları rejected olur", async () => {
    await approveMatch(db, moderator, siblingWinnerId);
    expect((await candidate(siblingWinnerId)).status).toBe("accepted");
    const loser = await candidate(siblingLoserId);
    expect(loser.status).toBe("rejected");
    expect(Number(loser.reviewed_by)).toBe(moderator.userId);

    const audit = await auditRows(siblingWinnerId);
    expect(audit[0].after.supersededCandidateIds).toEqual([siblingLoserId]);
  });

  it("approveMatch: teklif başka ürüne bağlıysa bağ ezilmez (conflict)", async () => {
    const result = await approveMatch(db, moderator, linkedCandidateId);
    expect(result).toEqual({ found: true, conflict: true });
    expect((await candidate(linkedCandidateId)).status).toBe("pending");
    expect(await offerProductId(linkedOfferId)).toBe(linkedToProductId);
    expect(await auditRows(linkedCandidateId)).toHaveLength(0);
  });

  it("rejectMatch: durumu 'rejected' yapar, offer.product_id'ye dokunmaz, denetim yazar", async () => {
    const result = await rejectMatch(db, moderator, rejectCandidateId);
    expect(result.found).toBe(true);

    const row = await candidate(rejectCandidateId);
    expect(row.status).toBe("rejected");
    expect(Number(row.reviewed_by)).toBe(moderator.userId);
    expect(await offerProductId(rejectOfferId)).toBeNull();

    const audit = await auditRows(rejectCandidateId);
    expect(audit.map((r) => r.action)).toEqual(["matching.reject"]);
  });

  it("zaten karara bağlanmış bir satır üzerinde found:false döner", async () => {
    const result = await approveMatch(db, moderator, alreadyDecidedCandidateId);
    expect(result.found).toBe(false);
  });

  it("var olmayan bir id için found:false döner", async () => {
    const result = await rejectMatch(db, moderator, 999_999_999);
    expect(result.found).toBe(false);
  });
});
