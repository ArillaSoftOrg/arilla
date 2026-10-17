/**
 * Yönetim paneli: sınıflandırma sayaçları (karar 0133). Sayaçlar yayındaki ürünleri sayar;
 * bekleyen = kontrol noktasından sonraki eksik ürünler + inceleme kuyruğu.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { AdminActor } from "./capabilities.ts";
import { countProductClassification, countProductQuality } from "./catalog.ts";

describe("yönetim: ürün sınıflandırma sayaçları - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let moderator: AdminActor;
  let userId = 0;
  let merchantId = 0;
  const ids: Record<string, number> = {};
  let savedState: unknown[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`cls-mod-${suffix}@test.local`],
      );
      userId = Number(user.rows[0].id);
      moderator = { userId, role: "moderator" };
      const merchant = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active)
         VALUES ($1, 'Cls', $2, 'xml_feed', TRUE) RETURNING id`,
        [`cls-${suffix}`, `cls-${suffix}.example`],
      );
      merchantId = Number(merchant.rows[0].id);
      const category = await client.query("SELECT id FROM category WHERE path = 'moda/canta'");
      // Var olan 'all' kontrol noktası korunur, test sonunda geri yüklenir.
      savedState = (await client.query("SELECT * FROM product_classification_state")).rows;
      await client.query("DELETE FROM product_classification_state");
      for (const key of ["done", "review", "error", "later"]) {
        const res = await client.query(
          `INSERT INTO product (slug, title, source_merchant_id, source_external_id,
                                publication_state, published_at, category_id)
           VALUES ($1, $2, $3, $4, 'published', now(), $5) RETURNING id`,
          [
            `cls-${key}-${suffix}`,
            `Cls ${key}`,
            merchantId,
            `${key}-${suffix}`,
            key === "done" ? category.rows[0].id : null,
          ],
        );
        ids[key] = Number(res.rows[0].id);
      }
      for (const [key, state] of [
        ["done", "applied"],
        ["review", "review"],
        ["error", "error"],
      ] as const) {
        await client.query(
          `INSERT INTO product_classification (product_id, rule_version, state, brand_basis,
                                               category_basis, confidence, detail)
           VALUES ($1, 1, $2, 'none', $3, 50, $4)`,
          [
            ids[key],
            state,
            state === "applied" ? "source" : "low_confidence",
            state === "error" ? "concurrent_change" : null,
          ],
        );
      }
      // Kontrol noktası "error" ürününde: "later" henüz taranmadı.
      await client.query(
        `INSERT INTO product_classification_state (rule_version, scope, last_product_id)
         VALUES (1, 'all', $1)`,
        [ids.error],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM product WHERE source_merchant_id = $1", [merchantId]);
      await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
      await client.query("DELETE FROM product_classification_state");
      for (const row of savedState as Record<string, unknown>[]) {
        const cols = Object.keys(row);
        await client.query(
          `INSERT INTO product_classification_state (${cols.join(", ")})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((c) => row[c]),
        );
      }
    });
  });

  it("bekleyen, inceleme ve hata sayılarını ayırır", async () => {
    const counts = await countProductClassification(db, moderator);
    expect(counts.ruleVersion).toBe(1);
    expect(counts.review).toBeGreaterThanOrEqual(1);
    expect(counts.errors).toBeGreaterThanOrEqual(1);
    // "later" (kontrol noktasından sonra, kategorisiz) + "review" (inceleme) bekler.
    expect(counts.pending).toBeGreaterThanOrEqual(2);
    expect(counts.pending).toBeGreaterThanOrEqual(counts.review);
  });

  it("belirlenen/bilinmeyen sayıları toplamla tutarlıdır", async () => {
    const quality = await countProductQuality(db, moderator);
    expect(quality.total - quality.no_category).toBeGreaterThanOrEqual(1);
    expect(quality.no_category).toBeGreaterThanOrEqual(3);
  });

  it("yetki ister", async () => {
    await expect(
      countProductClassification(db, { userId, role: "user" } as unknown as AdminActor),
    ).rejects.toThrow();
  });
});
