import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { deleteAccount } from "./delete-account.ts";

describe("deleteAccount() - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const email = `e3-delete-${suffix}@example.test`;
  let userId = 0;
  let creatorId = 0;
  let otherCreatorId = 0;
  let collectionId = 0;
  let merchantId = 0;
  let offerId = 0;
  let clickId = "";
  let followerId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        email,
      ]);
      userId = Number(user.rows[0].id);

      // Ikinci bir kullanici: bu user'i "creator" olarak takip ediyor -
      // follow(creator_id=...) yolunun da temizlendigini dogrulamak icin.
      const follower = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `e3-delete-follower-${suffix}@example.test`,
      ]);
      followerId = Number(follower.rows[0].id);

      const creatorResult = await client.query(
        `INSERT INTO creator (user_id, handle, display_name) VALUES ($1, $2, 'Silinecek Creator') RETURNING id`,
        [userId, `e3-delete-handle-${suffix}`],
      );
      creatorId = Number(creatorResult.rows[0].id);

      // followerId de kendi creator'ına sahip - userId'nin KENDİ takibinin
      // (follow.user_id) de temizlendiğini, creatorId'nin takipçisininkinden
      // (follow.creator_id) ayrı olarak doğrulamak için.
      const otherCreatorResult = await client.query(
        `INSERT INTO creator (user_id, handle, display_name) VALUES ($1, $2, 'Diğer Creator') RETURNING id`,
        [followerId, `e3-delete-other-handle-${suffix}`],
      );
      otherCreatorId = Number(otherCreatorResult.rows[0].id);

      const collectionResult = await client.query(
        `INSERT INTO collection (creator_id, slug, title) VALUES ($1, $2, 'Koleksiyon') RETURNING id`,
        [creatorId, `e3-delete-collection-${suffix}`],
      );
      collectionId = Number(collectionResult.rows[0].id);

      const merchant = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'E3 Delete Merchant', $2, 'xml_feed') RETURNING id`,
        [`e3-delete-merchant-${suffix}`, `e3-delete-${suffix}.test`],
      );
      merchantId = Number(merchant.rows[0].id);

      const product = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'E3 Delete Ürünü') RETURNING id",
        [`e3-delete-product-${suffix}`],
      );
      const productId = Number(product.rows[0].id);

      const offer = await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw)
         VALUES ($1, $2, $3, $4, 'E3 Delete Teklif') RETURNING id`,
        [merchantId, productId, `e3-delete-${suffix}`, `https://e3-delete.test/${suffix}`],
      );
      offerId = Number(offer.rows[0].id);

      await client.query(
        `INSERT INTO collection_item (collection_id, product_id) VALUES ($1, $2)`,
        [collectionId, productId],
      );
      await client.query(
        `INSERT INTO creator_affiliate_account (creator_id, merchant_id, tracking_id) VALUES ($1, $2, 'track-1')`,
        [creatorId, merchantId],
      );
      // followerId, silinecek kullaniciyi creator olarak takip ediyor.
      await client.query(`INSERT INTO follow (user_id, creator_id) VALUES ($1, $2)`, [
        followerId,
        creatorId,
      ]);
      // Silinecek kullanici da BASKA birini (otherCreatorId) takip ediyor.
      await client.query(`INSERT INTO follow (user_id, creator_id) VALUES ($1, $2)`, [
        userId,
        otherCreatorId,
      ]);

      await client.query(`INSERT INTO saved_item (user_id, product_id) VALUES ($1, $2)`, [
        userId,
        productId,
      ]);
      await client.query(
        `INSERT INTO alert (user_id, product_id, kind, target_price) VALUES ($1, $2, 'price_drop', 1000)`,
        [userId, productId],
      );
      await client.query(
        `INSERT INTO product_view (user_id, session_id, product_id) VALUES ($1, 'e3-delete-session', $2)`,
        [userId, productId],
      );
      await client.query(
        `INSERT INTO user_size_profile (user_id, category_path, size_norm) VALUES ($1, 'ayakkabi', '42')`,
        [userId],
      );
      await client.query(
        `INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'browsing_history', true)`,
        [userId],
      );

      const sessionInsert = await client.query(
        `INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, 'e3-delete-hash', now() + interval '1 day') RETURNING id`,
        [userId],
      );
      void sessionInsert;

      const clickResult = await client.query(
        `INSERT INTO click (user_id, session_id, offer_id, channel) VALUES ($1, 'e3-delete-session', $2, 'web') RETURNING id`,
        [userId, offerId],
      );
      clickId = clickResult.rows[0].id;

      await client.query(
        `INSERT INTO api_usage (user_id, operation) VALUES ($1, 'e3-delete-test-op')`,
        [userId],
      );
      await client.query(
        `INSERT INTO image_upload (user_id, session_id, image_hash, purge_after) VALUES ($1, 'e3-delete-session', 'e3-delete-hash', now() + interval '30 days')`,
        [userId],
      );
      await client.query(
        `INSERT INTO link_resolution_request (url_raw, session_id, user_id) VALUES ('https://e3-delete.test/link', 'e3-delete-session', $1)`,
        [userId],
      );
      await client.query(
        `INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, 'e3-delete-token-hash', now() + interval '15 minutes')`,
        [email],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM click WHERE offer_id IN (SELECT id FROM offer WHERE merchant_id = $1)",
        [merchantId],
      );
      await client.query("DELETE FROM api_usage WHERE operation = 'e3-delete-test-op'");
      await client.query("DELETE FROM image_upload WHERE session_id = 'e3-delete-session'");
      await client.query(
        "DELETE FROM link_resolution_request WHERE session_id = 'e3-delete-session'",
      );
      await client.query("DELETE FROM follow WHERE creator_id = ANY($1)", [
        [creatorId, otherCreatorId],
      ]);
      await client.query("DELETE FROM collection_item WHERE collection_id = $1", [collectionId]);
      await client.query("DELETE FROM creator_affiliate_account WHERE creator_id = $1", [
        creatorId,
      ]);
      await client.query("DELETE FROM collection WHERE id = $1", [collectionId]);
      await client.query("DELETE FROM creator WHERE id = ANY($1)", [[creatorId, otherCreatorId]]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`e3-delete-product-${suffix}`]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM auth_token WHERE email LIKE 'e3-delete-%'");
      await client.query("DELETE FROM app_user WHERE email LIKE 'e3-delete-%' OR id = $1", [
        followerId,
      ]);
    });
  });

  it("hesabı gerçekten siler, bağlı satırları temizler, click'i kimliksizleştirir", async () => {
    await deleteAccount(db, userId);

    await withOwnerClient(async (client) => {
      const user = await client.query("SELECT 1 FROM app_user WHERE id = $1", [userId]);
      expect(user.rows).toHaveLength(0);

      const creatorRow = await client.query("SELECT 1 FROM creator WHERE id = $1", [creatorId]);
      expect(creatorRow.rows).toHaveLength(0);

      const collectionRow = await client.query("SELECT 1 FROM collection WHERE id = $1", [
        collectionId,
      ]);
      expect(collectionRow.rows).toHaveLength(0);

      const savedRow = await client.query("SELECT 1 FROM saved_item WHERE user_id = $1", [userId]);
      expect(savedRow.rows).toHaveLength(0);

      const alertRow = await client.query("SELECT 1 FROM alert WHERE user_id = $1", [userId]);
      expect(alertRow.rows).toHaveLength(0);

      const sessionRow = await client.query("SELECT 1 FROM session WHERE user_id = $1", [userId]);
      expect(sessionRow.rows).toHaveLength(0);

      const viewRow = await client.query("SELECT 1 FROM product_view WHERE user_id = $1", [userId]);
      expect(viewRow.rows).toHaveLength(0);

      const sizeRow = await client.query("SELECT 1 FROM user_size_profile WHERE user_id = $1", [
        userId,
      ]);
      expect(sizeRow.rows).toHaveLength(0);

      const consentRow = await client.query("SELECT 1 FROM user_consent WHERE user_id = $1", [
        userId,
      ]);
      expect(consentRow.rows).toHaveLength(0);

      const authTokenRow = await client.query("SELECT 1 FROM auth_token WHERE email = $1", [email]);
      expect(authTokenRow.rows).toHaveLength(0);

      // Kimliksizlestirilir, SILINMEZ - satir hala var, user_id NULL.
      const clickRow = await client.query("SELECT user_id FROM click WHERE id = $1", [clickId]);
      expect(clickRow.rows).toHaveLength(1);
      expect(clickRow.rows[0].user_id).toBeNull();

      const apiUsageRow = await client.query(
        "SELECT user_id FROM api_usage WHERE operation = 'e3-delete-test-op'",
      );
      expect(apiUsageRow.rows).toHaveLength(1);
      expect(apiUsageRow.rows[0].user_id).toBeNull();

      const imageUploadRow = await client.query(
        "SELECT user_id FROM image_upload WHERE session_id = 'e3-delete-session'",
      );
      expect(imageUploadRow.rows).toHaveLength(1);
      expect(imageUploadRow.rows[0].user_id).toBeNull();

      const linkRow = await client.query(
        "SELECT user_id FROM link_resolution_request WHERE session_id = 'e3-delete-session'",
      );
      expect(linkRow.rows).toHaveLength(1);
      expect(linkRow.rows[0].user_id).toBeNull();

      // Baska birinin bu creator'i takip eden satiri da silinmis olmali.
      const followedRow = await client.query("SELECT 1 FROM follow WHERE creator_id = $1", [
        creatorId,
      ]);
      expect(followedRow.rows).toHaveLength(0);

      // Silinen kullanicinin KENDI takibi (baska bir creator'a) de gitmis olmali.
      const ownFollowRow = await client.query("SELECT 1 FROM follow WHERE user_id = $1", [userId]);
      expect(ownFollowRow.rows).toHaveLength(0);
    });
  });
});
