import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeQueryText } from "../search/normalize.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import { countProductQuality, getProductDetail, listOffers, searchProducts } from "./catalog.ts";
import { listImageUploads, summarizeImageUploads } from "./image-uploads.ts";
import { getOperationsOverview, runOrphanCheck } from "./operations.ts";
import { explainSearch, SearchDiagnosticsInputError } from "./search-diagnostics.ts";
import { getSeoDiagnostics } from "./seo.ts";
import { getUserDetail, lookupUser, UserLookupInputError } from "./users.ts";

describe("katalog, arama tanısı, işletim, kullanıcı, SEO - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let admin: AdminActor;
  let moderator: AdminActor;
  let subjectUserId = 0;
  let subjectPublicId = "";
  const subjectEmail = `diag-subject-${suffix}@test.local`;
  const subjectPhone = `+90532${String(suffix).slice(-7)}`;
  let merchantId = 0;
  let productId = 0;
  let unmatchedOfferId = 0;
  const gtin = `869${String(suffix).slice(-10)}`;
  const titleWord = `Zirkonyumtest${suffix}`;
  let imageUploadId = 0;

  const auditFor = (targetId: number | string, action: string) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT after FROM admin_audit_event
          WHERE target_type = 'app_user' AND target_id = $1 AND action = $2 AND actor_user_id = $3`,
        [String(targetId), action, admin.userId],
      );
      return res.rows;
    });

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const a = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`diag-admin-${suffix}@test.local`],
      );
      const m = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`diag-mod-${suffix}@test.local`],
      );
      admin = { userId: Number(a.rows[0].id), role: "admin" };
      moderator = { userId: Number(m.rows[0].id), role: "moderator" };

      const subject = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'user') RETURNING id, public_id",
        [subjectEmail],
      );
      subjectUserId = Number(subject.rows[0].id);
      subjectPublicId = subject.rows[0].public_id;
      await client.query(
        `INSERT INTO user_identity (user_id, provider, provider_subject) VALUES ($1, 'phone', $2)`,
        [subjectUserId, subjectPhone],
      );
      await client.query(
        `INSERT INTO session (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 day')`,
        [subjectUserId, `diag-hash-${suffix}`],
      );

      const merchantResult = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type)
         VALUES ($1, 'Diag Merchant', $2, 'xml_feed') RETURNING id`,
        [`diag-merchant-${suffix}`, `diag-${suffix}.test`],
      );
      merchantId = Number(merchantResult.rows[0].id);
      const productResult = await client.query(
        `INSERT INTO product (slug, title, gtin, offer_count) VALUES ($1, $2, $3, 1) RETURNING id`,
        [`diag-urun-${suffix}`, `${titleWord} Deri Canta`, gtin],
      );
      productId = Number(productResult.rows[0].id);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price)
         VALUES ($1, $2, 'd-1', $3, 'Diag Teklif', 150000)`,
        [merchantId, productId, `https://diag-${suffix}.test/p/1?utm=x`],
      );
      const unmatched = await client.query(
        `INSERT INTO offer (merchant_id, external_id, url, title_raw)
         VALUES ($1, 'd-2', $2, 'Diag Eşleşmemiş Teklif') RETURNING id`,
        [merchantId, `https://diag-${suffix}.test/p/2`],
      );
      unmatchedOfferId = Number(unmatched.rows[0].id);

      const upload = await client.query(
        `INSERT INTO image_upload (session_id, image_hash, object_key, status, purge_after)
         VALUES ('diag-oturum', $1, 'uploads/diag-gizli.jpg', 'embedded', now() - interval '1 day')
         RETURNING id`,
        [`diaghash${suffix}`],
      );
      imageUploadId = Number(upload.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM image_upload WHERE id = $1", [imageUploadId]);
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
      await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM product WHERE id = $1", [productId]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [admin.userId, moderator.userId, subjectUserId],
      ]);
    });
  });

  it("readOnly işlem yazmayı motor düzeyinde reddeder", async () => {
    await expect(
      readOnly(db, 1_000, (tx) =>
        tx.execute(sql`INSERT INTO lexicon (kind, surface, normalized) VALUES ('color','x','y')`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "25006" }) });
  });

  it("searchProducts: id, GTIN ve katlanmış başlıkla bulur; kalite filtresi", async () => {
    expect((await searchProducts(db, moderator, { query: String(productId) })).rows[0]?.id).toBe(
      productId,
    );
    expect((await searchProducts(db, moderator, { query: gtin })).rows.map((r) => r.id)).toEqual([
      productId,
    ]);
    const byTitle = await searchProducts(db, moderator, { query: titleWord.toLowerCase() });
    expect(byTitle.rows.map((r) => r.id)).toContain(productId);
    const noImage = await searchProducts(db, moderator, {
      query: titleWord,
      quality: "no_image",
    });
    expect(noImage.rows.map((r) => r.id)).toContain(productId);
    const counts = await countProductQuality(db, moderator);
    expect(counts.total).toBeGreaterThanOrEqual(1);
  });

  it("getProductDetail: teklif adresi sorgu dizisiz", async () => {
    const detail = await getProductDetail(db, moderator, productId);
    expect(detail?.offers[0]?.url).toBe(`https://diag-${suffix}.test/p/1?…`);
    expect(detail?.product.gtin).toBe(gtin);
    expect(await getProductDetail(db, moderator, 999_999_999)).toBeNull();
  });

  it("listOffers: eşleşmemiş aktif teklifler, mağaza filtresi", async () => {
    const unmatched = await listOffers(db, moderator, { state: "unmatched", merchantId });
    expect(unmatched.rows.map((r) => r.id)).toEqual([unmatchedOfferId]);
  });

  it("katalog user rolüne kapalı", async () => {
    await expect(
      searchProducts(db, { userId: moderator.userId, role: "user" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("explainSearch: gerçek boru hattı, query_resolution'a yazmaz", async () => {
    const text = `${titleWord} deri canta`;
    const norm = normalizeQueryText(text);
    const count = async () =>
      withOwnerClient(async (client) => {
        const res = await client.query(
          "SELECT count(*)::int AS n FROM query_resolution WHERE query_norm = $1",
          [norm],
        );
        return res.rows[0].n as number;
      });
    expect(await count()).toBe(0);
    const diagnostics = await explainSearch(db, moderator, text);
    expect(await count()).toBe(0);
    expect(diagnostics.queryNorm).toBe(norm);
    expect(diagnostics.cache.present).toBe(false);
    expect(
      diagnostics.effectiveSource === "fresh" || diagnostics.effectiveSource === "conversation",
    ).toBe(true);
    expect(Array.isArray(diagnostics.results)).toBe(true);

    await expect(explainSearch(db, moderator, "  ")).rejects.toBeInstanceOf(
      SearchDiagnosticsInputError,
    );
    await expect(explainSearch(db, moderator, "a".repeat(201))).rejects.toBeInstanceOf(
      SearchDiagnosticsInputError,
    );
  });

  it("görsel yüklemeler: nesne anahtarı dönmez, süresi geçmiş ham dosya işaretlenir", async () => {
    const page = await listImageUploads(db, moderator, { pageSize: 100 });
    const ours = page.rows.find((row) => row.id === imageUploadId);
    expect(ours?.rawStored).toBe(true);
    expect(ours?.purgeOverdue).toBe(true);
    expect(JSON.stringify(page)).not.toContain("diag-gizli");
    expect(JSON.stringify(page)).not.toContain("diag-oturum");
    const summary = await summarizeImageUploads(db, moderator);
    expect(summary.purgeOverdue).toBeGreaterThanOrEqual(1);
  });

  it("işletim: yalnızca yönetici; partition ve yetim denetimleri çalışır", async () => {
    await expect(getOperationsOverview(db, moderator)).rejects.toBeInstanceOf(AdminForbiddenError);
    const ops = await getOperationsOverview(db, admin);
    expect(ops.partitions.ok).toBe(true);
    if (ops.partitions.ok) {
      expect(ops.partitions.value.hasDefault).toBe(true);
      expect(ops.partitions.value.ranges.length).toBeGreaterThan(0);
    }
    expect(ops.compliance.ok && ops.compliance.value.imagePurgeOverdue).toBeGreaterThanOrEqual(1);
    expect(ops.jobs.ok).toBe(true);
    const orphans = await runOrphanCheck(db, admin);
    expect(orphans.ok).toBe(true);
  });

  it("kullanıcı arama: yalnızca yönetici, tam eşleşme, aranan değer denetime yazılmaz", async () => {
    await expect(lookupUser(db, moderator, subjectEmail)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(lookupUser(db, admin, "diag-subject")).rejects.toBeInstanceOf(
      UserLookupInputError,
    );

    expect((await lookupUser(db, admin, subjectEmail.toUpperCase())).publicId).toBe(
      subjectPublicId,
    );
    expect((await lookupUser(db, admin, subjectPhone)).publicId).toBe(subjectPublicId);
    expect((await lookupUser(db, admin, subjectPublicId)).publicId).toBe(subjectPublicId);
    expect((await lookupUser(db, admin, `yok-${suffix}@test.local`)).publicId).toBeNull();

    const lookups = await auditFor(subjectUserId, "users.lookup");
    expect(lookups).toHaveLength(3);
    expect(JSON.stringify(lookups)).not.toContain(subjectEmail);
    expect(JSON.stringify(lookups)).not.toContain(subjectPhone);
    expect(await auditFor("-", "users.lookup")).toHaveLength(1);
  });

  it("kullanıcı ayrıntısı: maskeli, sayımlar, görüntüleme denetime yazılır", async () => {
    const detail = await getUserDetail(db, admin, subjectPublicId);
    expect(detail?.emailMasked).toBe("d***@test.local");
    expect(detail?.phoneMasked).toBe(`+90 ••• ••• ••${subjectPhone.slice(-2)}`);
    expect(detail?.activeSessions).toBe(1);
    expect(detail?.identities.map((i) => i.provider)).toEqual(["phone"]);
    expect(JSON.stringify(detail)).not.toContain(subjectPhone);
    expect(JSON.stringify(detail)).not.toContain(`diag-hash-${suffix}`);
    expect(await auditFor(subjectUserId, "users.view")).toHaveLength(1);
    await expect(getUserDetail(db, moderator, subjectPublicId)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });

  it("SEO tanısı: kendi verimizden sayımlar ve sitemap parçaları", async () => {
    const seo = await getSeoDiagnostics(db, moderator);
    expect(seo.products.total).toBeGreaterThanOrEqual(1);
    expect(seo.products.missingImage).toBeGreaterThanOrEqual(1);
    expect(seo.sitemap?.shardSize).toBe(50_000);
    expect(seo.slugHistory.conflicts).toBeGreaterThanOrEqual(0);
  });
});
