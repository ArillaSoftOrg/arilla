/**
 * Analitik merkez (karar 0085) — gerçek Postgres. Yerel veritabanında başka
 * veri olabileceği için sayımlar FARKLA (önce/sonra) doğrulanır; tohum
 * satırları benzersiz etiket taşır ve sonunda silinir.
 *
 * Gizlilik sözleşmesi de burada: sohbet içeriği, oturum kimliği ve kullanıcı
 * e-postası hiçbir çıktıda geçmez; kullanıcıya göre gruplama yoktur.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getAffiliateOverview } from "./affiliate.ts";
import { getAiOperationsOverview } from "./ai-operations.ts";
import type { AdminActor } from "./capabilities.ts";
import { getCatalogFreshness, getMatchingAccuracy } from "./quality-insights.ts";
import { getUserJourneyOverview } from "./user-journey.ts";

describe("analitik merkez - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const tag = `acx${Date.now().toString(36)}`;
  const secretContent = `GIZLI-SOHBET-${tag}`;
  const secretSession = `oturum-${tag}`;
  const model = `test-model-${tag}`;
  let admin: AdminActor;
  const userIds: number[] = [];
  let merchantId = 0;
  let offerId = 0;
  let productId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const a = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`${tag}-admin@test.local`],
      );
      admin = { userId: Number(a.rows[0].id), role: "admin" };
      userIds.push(admin.userId);
      const m = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, affiliate_status, deeplink_template)
         VALUES ($1, 'ACX Mağaza', $2, 'xml_feed', 'active', 'https://example.test/{url}') RETURNING id`,
        [`${tag}-magaza`, `${tag}.test`],
      );
      merchantId = Number(m.rows[0].id);
      const p = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'ACX') RETURNING id",
        [`${tag}-urun`],
      );
      productId = Number(p.rows[0].id);
      const o = await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, currency, last_seen_at)
         VALUES ($1, $2, $3, 'https://example.test/p', 'ACX teklif', 1000, 'TRY', now() - interval '30 days')
         RETURNING id`,
        [merchantId, productId, `${tag}-ext`],
      );
      offerId = Number(o.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM api_usage WHERE model_version = $1", [model]);
      await client.query("DELETE FROM click WHERE offer_id = $1", [offerId]);
      await client.query("DELETE FROM match_candidate WHERE offer_id = $1", [offerId]);
      await client.query("DELETE FROM offer WHERE id = $1", [offerId]);
      await client.query("DELETE FROM product WHERE slug LIKE $1", [`${tag}-urun%`]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM user_activity_event WHERE user_id = ANY($1)", [userIds]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
    });
  });

  it("AI: işlem × model toplamı, tahmini/fiyatlanmamış ayrımı; sohbet içeriği ve kullanıcı yok", async () => {
    const before = await getAiOperationsOverview(db, admin, { days: 7 });
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO api_usage (user_id, session_id, operation, model_version, units, cost_micros, cache_hit)
         VALUES ($1, $2, 'chat_turn', $3, 120, 500, FALSE),
                ($1, $2, 'chat_turn', $3, 30, 0, FALSE)`,
        [admin.userId, secretSession, model],
      );
      const c = await client.query(
        "INSERT INTO conversation (user_id, title) VALUES ($1, $2) RETURNING id",
        [admin.userId, secretContent],
      );
      await client.query(
        `INSERT INTO chat_message (conversation_id, seq, role, kind, content)
         VALUES ($1, 1, 'user', 'text', $2), ($1, 2, 'assistant', 'clarify', $2)`,
        [c.rows[0].id, secretContent],
      );
    });
    const after = await getAiOperationsOverview(db, admin, { days: 7 });
    const row = after.usage.find((r) => r.modelVersion === model);
    expect(row).toMatchObject({
      operation: "chat_turn",
      calls: 2,
      units: 150,
      costMicros: 500,
      unpricedCalls: 1,
      cacheHits: 0,
    });
    expect(after.chat.userMessages - before.chat.userMessages).toBe(1);
    expect(after.chat.conversationsStarted - before.chat.conversationsStarted).toBe(1);
    const text = JSON.stringify(after);
    expect(text).not.toContain(secretContent);
    expect(text).not.toContain(secretSession);
    expect(text).not.toContain(`${tag}-admin`);
    expect(after.caps.map((cap) => cap.operation).sort()).toEqual(
      ["chat_turn", "query_interpretation", "query_interpretation_realtime"].sort(),
    );
  });

  it("yolculuk: rızada kişi başına SON karar; örneklem 5+ kişiyle görünür, kimlik çıkmaz", async () => {
    const before = await getUserJourneyOverview(db, admin, { days: 7 });
    await withOwnerClient(async (client) => {
      for (let i = 0; i < 6; i++) {
        const u = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
          `${tag}-u${i}@test.local`,
        ]);
        const id = Number(u.rows[0].id);
        userIds.push(id);
        await client.query(
          `INSERT INTO user_activity_event (user_id, kind, channel, search_mode, query_norm, result_count)
           VALUES ($1, 'search_submitted', 'web', 'text', $2, 3)`,
          [id, `sorgu ${tag}`],
        );
      }
      // u0: önce verdi, sonra geri aldı → yalnızca "vermedi" sayılır.
      await client.query(
        `INSERT INTO user_consent (user_id, kind, granted, granted_at)
         VALUES ($1, 'cookie_analytics', TRUE, now() - interval '1 hour'),
                ($1, 'cookie_analytics', FALSE, now())`,
        [userIds[1]],
      );
    });
    const after = await getUserJourneyOverview(db, admin, { days: 7 });
    const consentBefore = before.consent.find((c) => c.kind === "cookie_analytics");
    const consentAfter = after.consent.find((c) => c.kind === "cookie_analytics");
    expect((consentAfter?.denied ?? 0) - (consentBefore?.denied ?? 0)).toBe(1);
    expect((consentAfter?.granted ?? 0) - (consentBefore?.granted ?? 0)).toBe(0);
    const search = after.sample.find((cell) => cell.kind === "search_submitted");
    expect(search?.suppressed).toBe(false);
    expect(search?.users ?? 0).toBeGreaterThanOrEqual(6);
    expect(after.totalUsers - before.totalUsers).toBe(6);
    const text = JSON.stringify(after);
    expect(text).not.toContain(`sorgu ${tag}`);
    expect(text).not.toContain(`${tag}-u0`);
  });

  it("affiliate: mağaza/yüzey toplamı ve etkin affiliate payı; oturum kimliği çıkmaz", async () => {
    const before = await getAffiliateOverview(db, admin, { days: 7 });
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO click (session_id, offer_id, product_id, channel, surface)
         VALUES ($1, $2, $3, 'web', 'search'), ($1, $2, $3, 'web', 'search'), ($1, $2, $3, 'web', 'compare')`,
        [secretSession, offerId, productId],
      );
    });
    const after = await getAffiliateOverview(db, admin, { days: 7 });
    expect(after.totalClicks - before.totalClicks).toBe(3);
    expect(after.clicksToActiveAffiliate - before.clicksToActiveAffiliate).toBe(3);
    expect(after.byMerchant.find((m) => m.merchantId === merchantId)).toMatchObject({
      clicks: 3,
      affiliateStatus: "active",
      hasDeeplink: true,
    });
    expect(JSON.stringify(after)).not.toContain(secretSession);
  });

  it("eşleştirme doğruluğu: yöntem ve skor bandına göre insan kararları", async () => {
    const before = await getMatchingAccuracy(db, admin, { days: 30 });
    await withOwnerClient(async (client) => {
      // Aday (offer, product) başına tekildir: red için ikinci ürün.
      const other = await client.query(
        "INSERT INTO product (slug, title) VALUES ($1, 'ACX 2') RETURNING id",
        [`${tag}-urun-2`],
      );
      await client.query(
        `INSERT INTO match_candidate (offer_id, product_id, score, method, status, reviewed_at, review_reason)
         VALUES ($1, $2, 0.9, 'gtin', 'accepted', now(), NULL),
                ($1, $3, 0.65, 'text', 'rejected', now(), 'not_same_product')`,
        [offerId, productId, Number(other.rows[0].id)],
      );
    });
    const after = await getMatchingAccuracy(db, admin, { days: 30 });
    const band = (a: typeof after, key: string) => a.byBand.find((b) => b.band === key);
    expect((band(after, "ge_084")?.accepted ?? 0) - (band(before, "ge_084")?.accepted ?? 0)).toBe(
      1,
    );
    expect((band(after, "063_070")?.rejected ?? 0) - (band(before, "063_070")?.rejected ?? 0)).toBe(
      1,
    );
  });

  it("katalog tazeliği: 30 gün önce görülen aktif teklif bayat sayılır", async () => {
    const fresh = await getCatalogFreshness(db, admin);
    expect(fresh.staleOffers).toBeGreaterThanOrEqual(1);
    expect(fresh.activeOffers).toBeGreaterThanOrEqual(fresh.staleOffers);
    expect(fresh.seen24h).toBeLessThanOrEqual(fresh.seen7d);
  });
});
