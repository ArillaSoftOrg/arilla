import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import { listIngestRuns } from "./ingest-runs.ts";
import { listLinkRequests, summarizeLinkRequests } from "./link-requests.ts";
import {
  getMerchantDetail,
  listMerchants,
  MerchantValidationError,
  setMerchantActive,
} from "./merchants.ts";

describe("mağaza, koşu ve link tanısı - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const slug = `admin-merchant-${suffix}`;
  const host = `admin-merchant-${suffix}.test`;
  let merchantId = 0;
  let admin: AdminActor;
  let moderator: AdminActor;
  const linkIds: string[] = [];

  const auditFor = (id: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT action, before, after, reason FROM admin_audit_event
          WHERE target_type = 'merchant' AND target_id = $1 ORDER BY id`,
        [String(id)],
      );
      return res.rows;
    });

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const a = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`merchant-admin-${suffix}@test.local`],
      );
      const m = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`merchant-mod-${suffix}@test.local`],
      );
      admin = { userId: Number(a.rows[0].id), role: "admin" };
      moderator = { userId: Number(m.rows[0].id), role: "moderator" };

      const merchantResult = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config, is_active,
                               deeplink_template)
         VALUES ($1, 'Admin Merchant Test', $2, 'shopify',
                 'https://feeds.test/export.xml?api_key=GIZLI-ANAHTAR',
                 '{"currency":"TRY","currency_verified":true,"category_hint":"moda/canta",
                   "transport":{"token":"GIZLI-TOKEN"},"api_key":"GIZLI-2"}'::jsonb,
                 TRUE, 'https://aff.test/?id=GIZLI-AFF&u={url}')
         RETURNING id`,
        [slug, host],
      );
      merchantId = Number(merchantResult.rows[0].id);

      for (const [i, active, matched] of [
        [1, true, false],
        [2, true, false],
        [3, false, false],
      ] as const) {
        await client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, is_active)
           VALUES ($1, $2, $3, 'Admin Merchant Teklif', $4)`,
          [merchantId, `am-${i}`, `https://${host}/p/${i}`, active],
        );
        void matched;
      }

      // Başarılı koşu, sonra iki başarısız (biri kapı reddi, biri token'lı hata).
      await client.query(
        `INSERT INTO ingest_run (merchant_id, started_at, finished_at, status, offers_seen)
         VALUES ($1, now() - interval '3 hours', now() - interval '3 hours' + interval '1 minute', 'success', 3)`,
        [merchantId],
      );
      await client.query(
        `INSERT INTO ingest_run (merchant_id, started_at, finished_at, status, error_text)
         VALUES ($1, now() - interval '2 hours', now() - interval '2 hours', 'failed',
                 'refused:currency_unverified feed_config.currency_verified is not true')`,
        [merchantId],
      );
      await client.query(
        `INSERT INTO ingest_run (merchant_id, started_at, finished_at, status, error_text)
         VALUES ($1, now() - interval '1 hour', now() - interval '1 hour', 'failed',
                 'HTTPError 401 for url: https://feeds.test/export.xml?api_key=GIZLI-ANAHTAR')`,
        [merchantId],
      );

      for (let i = 0; i < 3; i++) {
        const res = await client.query(
          `INSERT INTO link_resolution_request (url_raw, session_id, status, normalized_url,
                                                error_code, source, error_text, created_at)
           VALUES ($1, 'oturum-gizli', $2, $3, $4, $5::jsonb, $6, now() - ($7 || ' minutes')::interval)
           RETURNING id`,
          [
            `https://${host}/urun/${i}?token=KULLANICI-GIZLI`,
            i === 0 ? "resolved" : "failed",
            `https://${host}/urun/${i}?renk=siyah`,
            i === 0 ? null : "timeout",
            JSON.stringify({ title: `Ürün ${i}`, price: 1999, cookie: "GIZLI-CEREZ" }),
            i === 0 ? null : `timeout fetching https://${host}/urun/${i}?token=KULLANICI-GIZLI`,
            String(i),
          ],
        );
        linkIds.push(res.rows[0].id);
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM link_resolution_request WHERE id = ANY($1::uuid[])", [
        linkIds,
      ]);
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
      await client.query("DELETE FROM ingest_run WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
    });
  });

  it("listMerchants: sayımlar, son koşu, son başarı, ardışık hata", async () => {
    const { rows } = await listMerchants(db, moderator, { search: slug });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.offersTotal).toBe(3);
    expect(row?.offersActive).toBe(2);
    expect(row?.offersUnmatched).toBe(2);
    expect(row?.lastRun?.status).toBe("failed");
    expect(row?.lastSuccessAt).not.toBeNull();
    expect(row?.failuresSinceSuccess).toBe(2);
    expect(row?.currency).toBe("TRY");
    expect(row?.currencyVerified).toBe(true);
  });

  it("arama terimindeki % ve _ joker değildir", async () => {
    const { rows } = await listMerchants(db, moderator, { search: "%" });
    expect(rows.some((row) => row.slug === slug)).toBe(false);
  });

  it("getMerchantDetail: gizli alanlar dönmez", async () => {
    const detail = await getMerchantDetail(db, moderator, slug);
    const json = JSON.stringify(detail);
    expect(json).not.toContain("GIZLI");
    expect(detail?.feedUrl).toBe("https://feeds.test/export.xml?…");
    expect(detail?.hasDeeplinkTemplate).toBe(true);
    expect(detail?.feed.keys).toEqual(expect.arrayContaining(["transport", "api_key", "currency"]));
    expect(await getMerchantDetail(db, moderator, "yok-boyle-bir-magaza")).toBeNull();
  });

  it("user rolü mağaza listesini okuyamaz", async () => {
    await expect(
      listMerchants(db, { userId: moderator.userId, role: "user" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("setMerchantActive: moderator yapamaz, hiçbir şey değişmez", async () => {
    await expect(
      setMerchantActive(db, moderator, {
        merchantId,
        active: false,
        reason: "deneme gerekçesi",
        confirmSlug: slug,
      }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
    expect((await getMerchantDetail(db, admin, slug))?.isActive).toBe(true);
  });

  it("setMerchantActive: yanlış onay adı ve kısa gerekçe reddedilir", async () => {
    await expect(
      setMerchantActive(db, admin, {
        merchantId,
        active: false,
        reason: "yeterli bir gerekçe",
        confirmSlug: "baska-magaza",
      }),
    ).rejects.toBeInstanceOf(MerchantValidationError);
    await expect(
      setMerchantActive(db, admin, { merchantId, active: false, reason: "kı", confirmSlug: slug }),
    ).rejects.toBeInstanceOf(MerchantValidationError);
    expect(await auditFor(merchantId)).toHaveLength(0);
  });

  it("setMerchantActive: yönetici kapatır, denetime gerekçeyle yazılır; tekrar no-op", async () => {
    const result = await setMerchantActive(db, admin, {
      merchantId,
      active: false,
      reason: "Feed 401 veriyor, anahtar yenilenene kadar",
      confirmSlug: slug,
    });
    expect(result).toEqual({ found: true, changed: true });
    expect((await getMerchantDetail(db, admin, slug))?.isActive).toBe(false);

    const again = await setMerchantActive(db, admin, {
      merchantId,
      active: false,
      reason: "ikinci kez kapatma",
      confirmSlug: slug,
    });
    expect(again).toEqual({ found: true, changed: false });

    const audit = await auditFor(merchantId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("merchant.deactivate");
    expect(audit[0].before.isActive).toBe(true);
    expect(audit[0].after.isActive).toBe(false);
    expect(audit[0].reason).toContain("Feed 401");
  });

  it("listIngestRuns: mağaza filtresi, imleç, kapı kodu, hata metninden token atılır", async () => {
    const first = await listIngestRuns(db, moderator, { merchantId, pageSize: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]?.errorText).not.toContain("GIZLI");
    expect(first.rows[0]?.errorText).toContain("https://feeds.test/export.xml?…");
    expect(first.rows[1]?.refusedCode).toBe("currency_unverified");
    const second = await listIngestRuns(db, moderator, {
      merchantId,
      pageSize: 2,
      beforeId: first.nextBeforeId ?? undefined,
    });
    expect(second.rows.map((r) => r.status)).toEqual(["success"]);
    expect(second.nextBeforeId).toBeNull();

    const failed = await listIngestRuns(db, moderator, { merchantId, status: "failed" });
    expect(failed.rows).toHaveLength(2);
  });

  it("listLinkRequests: oturum/ham adres/izinsiz alan dönmez; ana makine filtresi ve imleç", async () => {
    const first = await listLinkRequests(db, moderator, { host, pageSize: 2 });
    expect(first.rows).toHaveLength(2);
    const json = JSON.stringify(first);
    expect(json).not.toContain("GIZLI");
    expect(json).not.toContain("oturum-gizli");
    expect(first.rows[0]?.url).toBe(`https://${host}/urun/0?…`);
    expect(first.rows[0]?.source).toEqual({ title: "Ürün 0", price: "1999" });

    const second = await listLinkRequests(db, moderator, {
      host,
      pageSize: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.rows).toHaveLength(1);
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);

    const timeouts = await listLinkRequests(db, moderator, { host, errorCode: "timeout" });
    expect(timeouts.rows).toHaveLength(2);

    const summary = await summarizeLinkRequests(db, moderator);
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.byErrorCode.timeout).toBeGreaterThanOrEqual(2);
  });

  it("bozuk imleç ve ana makine yok sayılır", async () => {
    const result = await listLinkRequests(db, moderator, {
      host: "' OR 1=1 --",
      cursor: "bozuk|imlec",
      pageSize: 1,
    });
    expect(result.rows.length).toBeLessThanOrEqual(1);
  });
});
