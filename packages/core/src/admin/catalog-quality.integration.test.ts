/**
 * Katalog kalitesi (karar 0053) — gerçek yerel Postgres. Paylaşılan veritabanı
 * başka satırlar da taşıyabildiği için sayılar, fikstürden ÖNCE alınan taban
 * çizgisine göre fark olarak doğrulanır.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import { listOffers, searchProducts } from "./catalog.ts";
import {
  type CatalogQualityFinding,
  type CatalogQualityReport,
  getCatalogQualityReport,
  QUALITY_SAMPLE_LIMIT,
} from "./catalog-quality.ts";

const VALID_A = "8690000000012";
const VALID_B = "8690000000029";
const VALID_C = "96385074";
const INVALID = "8690000000017";

describe("katalog kalitesi - entegrasyon", () => {
  let db: Database;
  const tag = `kq${Date.now().toString(36)}`;
  let moderator: AdminActor;
  const merchantIds: number[] = [];
  const productIds: number[] = [];
  let brandId = 0;
  const ids: Record<string, number> = {};
  let baseline: CatalogQualityReport;

  const byKey = (report: CatalogQualityReport, key: string): CatalogQualityFinding => {
    const f = report.findings.find((x) => x.key === key);
    if (!f) throw new Error(`bulgu yok: ${key}`);
    return f;
  };
  const delta = (report: CatalogQualityReport, key: string) =>
    (byKey(report, key).count ?? 0) - (byKey(baseline, key).count ?? 0);

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const u = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`${tag}-mod@test.local`],
      );
      moderator = { userId: Number(u.rows[0].id), role: "moderator" };
    });
    baseline = await getCatalogQualityReport(db, moderator);

    await withOwnerClient(async (client) => {
      const merchant = async (key: string, active = true) => {
        const r = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $2, $3, 'xml_feed', $4) RETURNING id`,
          [`${tag}-${key}`, `${tag} ${key}`, `${tag}-${key}.test`, active],
        );
        const id = Number(r.rows[0].id);
        merchantIds.push(id);
        ids[`m_${key}`] = id;
        return id;
      };
      const open = await merchant("acik");
      const closed = await merchant("kapali", false);
      const bulk = await merchant("toplu");

      const b = await client.query(
        "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
        [`${tag}-marka`, `${tag} Marka`, `${tag}marka`],
      );
      brandId = Number(b.rows[0].id);

      const product = async (
        key: string,
        values: { title?: string; gtin?: string | null; brand?: boolean; color?: string },
      ) => {
        const r = await client.query(
          `INSERT INTO product (slug, title, brand_id, gtin, color, primary_image_url)
           VALUES ($1, $2, $3, $4, $5, 'https://kq.test/p.jpg') RETURNING id`,
          [
            `${tag}-${key}`,
            values.title ?? `${tag} ${key}`,
            values.brand === false ? null : brandId,
            values.gtin ?? null,
            values.color ?? null,
          ],
        );
        const id = Number(r.rows[0].id);
        productIds.push(id);
        ids[`p_${key}`] = id;
        return id;
      };
      const dupA = await product("dup-a", { gtin: VALID_A });
      await product("dup-b", { gtin: VALID_A });
      const twinA = await product("ikiz-a", { title: `${tag} Ikiz Urun`, color: "siyah" });
      await product("ikiz-b", { title: `${tag} IKIZ URUN `, color: "Siyah" });
      // Aynı başlık, farklı renk: olası çift SAYILMAZ (renk düzeyinde kanonik).
      await product("ikiz-c", { title: `${tag} Ikiz Urun`, color: "bej" });
      await product("teklifsiz", { brand: false });
      const conflictProduct = await product("catisma", { gtin: VALID_B });

      const offer = async (
        key: string,
        merchantId: number,
        productId: number | null,
        attributes: Record<string, string> = {},
        extra: { active?: boolean; lastSeenDays?: number; firstSeen?: string } = {},
      ) => {
        const r = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, attributes_raw,
                              is_active, last_seen_at, first_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now() - ($8 * interval '1 day'), $9) RETURNING id`,
          [
            merchantId,
            productId,
            `${tag}-${key}`,
            `https://kq.test/${key}`,
            `${tag} teklif ${key}`,
            JSON.stringify(attributes),
            extra.active ?? true,
            extra.lastSeenDays ?? 0,
            extra.firstSeen ?? new Date().toISOString(),
          ],
        );
        const id = Number(r.rows[0].id);
        ids[`o_${key}`] = id;
        return id;
      };
      const longAgo = "2000-01-01T00:00:00Z";
      const noCand = await offer("adaysiz", open, null, {}, { firstSeen: longAgo });
      const rejOnly = await offer("reddedilmis", open, null, {}, { firstSeen: longAgo });
      const decided = await offer("kabullu", open, null, {}, { firstSeen: longAgo });
      await offer("gecersiz", open, dupA, { gtin: INVALID });
      await offer("catisan", open, conflictProduct, { gtin: VALID_C });
      await offer("bayat", open, dupA, {}, { lastSeenDays: 30 });
      await offer("pasif", open, dupA, {}, { active: false });
      for (let i = 0; i < 3; i++) await offer(`kopya-${i}`, open, twinA);
      await offer("kapali-aktif", closed, twinA);
      for (let i = 0; i < 20; i++) await offer(`toplu-${i}`, bulk, null);

      await client.query(
        `INSERT INTO match_candidate (offer_id, product_id, score, method, status)
         VALUES ($1, $3, 0.7, 'text', 'rejected'), ($2, $3, 0.7, 'text', 'accepted')`,
        [rejOnly, decided, dupA],
      );
      ids.noCand = noCand;
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM match_candidate WHERE offer_id IN (SELECT id FROM offer WHERE merchant_id = ANY($1))",
        [merchantIds],
      );
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [merchantIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
      await client.query("DELETE FROM brand WHERE id = $1", [brandId]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [merchantIds]);
      await client.query("DELETE FROM app_user WHERE id = $1", [moderator.userId]);
    });
  });

  it("yetkisiz aktör rapor alamaz", async () => {
    await expect(
      getCatalogQualityReport(db, { userId: moderator.userId, role: "user" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("taban çizgisinde hiçbir denetim bilinmiyor değil; örnekler sınırlı", () => {
    for (const f of baseline.findings) {
      expect(f.severity).not.toBe("unknown");
      expect(f.samples.length).toBeLessThanOrEqual(QUALITY_SAMPLE_LIMIT);
    }
  });

  it("fikstürleri doğru bulgulara sayar", async () => {
    const report = await getCatalogQualityReport(db, moderator);
    expect(delta(report, "catalog.duplicate_gtin")).toBe(1);
    expect(delta(report, "catalog.probable_duplicate")).toBe(1);
    expect(delta(report, "catalog.product_no_brand")).toBe(1);
    expect(delta(report, "catalog.invalid_gtin")).toBe(1);
    expect(delta(report, "catalog.gtin_conflict")).toBe(1);
    expect(delta(report, "catalog.stale_offers")).toBe(1);
    expect(delta(report, "catalog.inactive_offers")).toBe(1);
    expect(delta(report, "catalog.inactive_merchant_active_offers")).toBe(1);
    expect(delta(report, "catalog.merchant_same_product")).toBe(1);
    expect(delta(report, "catalog.merchant_mostly_unmatched")).toBe(1);
    expect(delta(report, "catalog.unmatched_no_candidate")).toBe(21);
    expect(delta(report, "catalog.unmatched_rejected_only")).toBe(1);
    expect(delta(report, "catalog.unmatched_decided")).toBe(1);
    // teklifsiz + ikiz-b + ikiz-c + dup-b (aktif teklifsiz) ve kardeşleri
    expect(delta(report, "catalog.product_no_active_offer")).toBeGreaterThanOrEqual(4);

    // 48 saatten eski adaysız teklif: uyarı; en eski önce örneklenir.
    const noCand = byKey(report, "catalog.unmatched_no_candidate");
    expect(noCand.severity).toBe("warning");
    expect(noCand.samples.some((s) => s.label.startsWith(`Teklif #${ids.noCand} `))).toBe(true);
    expect(byKey(report, "catalog.unmatched_decided").severity).toBe("warning");
    expect(byKey(report, "catalog.inactive_offers").severity).not.toBe("critical");
  });

  it("bağlantılar yalnızca yönetim katalog/mağaza sayfalarına; tam URL yok", async () => {
    const report = await getCatalogQualityReport(db, moderator);
    for (const f of report.findings) {
      const hrefs = [f.href, ...f.samples.map((s) => s.href)].filter((h): h is string => !!h);
      for (const href of hrefs) {
        expect(href).toMatch(/^\/yonetim\/(katalog\/(urunler|teklifler)|magazalar)(\/|\?|$)/);
      }
      expect(JSON.stringify(f)).not.toContain("https://");
    }
  });

  it("zaman bütçesi aşılırsa denetimler bilinmiyor döner, sağlıklı değil", async () => {
    const report = await getCatalogQualityReport(db, moderator, { budgetMs: -1 });
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.severity === "unknown" && f.count === null)).toBe(true);
  });

  it("teklif listesi: adaysız, hep reddedilmiş, geçersiz barkod, #kimlik", async () => {
    const merchantId = ids.m_acik;
    const noCand = await listOffers(db, moderator, { state: "no_candidate", merchantId });
    expect(noCand.rows.map((r) => r.id)).toEqual(expect.arrayContaining([ids.o_adaysiz]));
    expect(noCand.rows.some((r) => r.id === ids.o_reddedilmis)).toBe(false);
    const row = noCand.rows.find((r) => r.id === ids.o_adaysiz);
    expect(row).toMatchObject({
      hasIdentifier: false,
      hasImageVector: false,
      rejectedCandidates: 0,
    });
    expect(row?.firstSeenAt.getUTCFullYear()).toBe(2000);

    const rejected = await listOffers(db, moderator, { state: "rejected_only", merchantId });
    expect(rejected.rows.map((r) => r.id)).toEqual([ids.o_reddedilmis]);
    expect(rejected.rows[0]?.rejectedCandidates).toBe(1);

    const invalid = await listOffers(db, moderator, { state: "invalid_gtin", merchantId });
    expect(invalid.rows.map((r) => r.id)).toEqual([ids.o_gecersiz]);
    expect(invalid.rows[0]).toMatchObject({ gtin: INVALID, hasIdentifier: true });

    const byId = await listOffers(db, moderator, { state: "all", query: `#${ids.o_catisan}` });
    expect(byId.rows.map((r) => r.id)).toEqual([ids.o_catisan]);
  });

  it("ürün sorun filtreleri: çift barkod ve aktif teklifsiz", async () => {
    const dup = await searchProducts(db, moderator, { issue: "duplicate_gtin", query: VALID_A });
    expect(dup.rows.map((r) => r.id).sort()).toEqual([ids["p_dup-a"], ids["p_dup-b"]].sort());
    const none = await searchProducts(db, moderator, {
      issue: "no_active_offer",
      query: `${tag} teklifsiz`,
    });
    expect(none.rows.map((r) => r.id)).toEqual([ids.p_teklifsiz]);
  });
});
