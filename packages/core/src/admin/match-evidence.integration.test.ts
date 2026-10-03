/**
 * Eşleştirme kuyruğu kanıtı (karar 0053) — gerçek yerel Postgres. Kardeş
 * teklifler sınırlı ve toplu okunur; kimlik uyumu resolver kurallarına göre
 * hesaplanır; açıklaması olmayan eski satır kanıtsız değil "açıklamasız" döner.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listMatchQueue, SIBLINGS_PER_PRODUCT } from "./matching-queue.ts";

describe("eşleştirme kanıtı - entegrasyon", () => {
  let db: Database;
  const tag = `mev${Date.now().toString(36)}`;
  const merchantIds: number[] = [];
  const productIds: number[] = [];
  let brandId = 0;
  let queueMerchantId = 0;
  let explainedCandidateId = 0;
  let bareCandidateId = 0;
  let conflictCandidateId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (name: string) => {
        const r = await client.query(
          `INSERT INTO merchant (slug, name, domain, source_type)
           VALUES ($1, $2, $3, 'xml_feed') RETURNING id`,
          [`${tag}-${name}`, `${tag} ${name}`, `${tag}-${name}.test`],
        );
        const id = Number(r.rows[0].id);
        merchantIds.push(id);
        return id;
      };
      queueMerchantId = await merchant("kuyruk");
      const otherMerchant = await merchant("diger");

      const b = await client.query(
        "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
        [`${tag}-marka`, `${tag} Marka`, `${tag}marka`],
      );
      brandId = Number(b.rows[0].id);

      const product = async (name: string, gtin: string | null) => {
        const r = await client.query(
          `INSERT INTO product (slug, title, brand_id, gtin, min_price, offer_count)
           VALUES ($1, $2, $3, $4, 99900, 1) RETURNING id`,
          [`${tag}-${name}`, `${tag} ${name}`, brandId, gtin],
        );
        const id = Number(r.rows[0].id);
        productIds.push(id);
        return id;
      };
      const rich = await product("zengin", "8690000000012");
      const bare = await product("bos", null);
      const conflict = await product("catisma", "8690000000029");

      const offer = async (
        merchantId: number,
        externalId: string,
        productId: number | null,
        price: number,
        attributes: Record<string, string> = {},
      ) => {
        const r = await client.query(
          `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, attributes_raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            merchantId,
            productId,
            `${tag}-${externalId}`,
            `https://${tag}.test/${externalId}?ref=secret`,
            `${tag} teklif ${externalId}`,
            price,
            JSON.stringify(attributes),
          ],
        );
        return Number(r.rows[0].id);
      };

      // 10 kardeş: biri kuyruk mağazasından, biri pasif (sayılmaz).
      const sameMerchantSibling = await offer(queueMerchantId, "kardes-0", rich, 50000);
      await client.query(
        `INSERT INTO offer_variant (offer_id, external_id, size_label, gtin, gtin_source)
         VALUES ($1, 'v', '50 ml', '8690000000012', 'feed')`,
        [sameMerchantSibling],
      );
      for (let i = 1; i < 10; i++) {
        await offer(otherMerchant, `kardes-${i}`, rich, 60000 + i, { mpn: "MPN-1" });
      }
      const inactive = await offer(otherMerchant, "pasif", rich, 100);
      await client.query("UPDATE offer SET is_active = false WHERE id = $1", [inactive]);

      const queued = await offer(queueMerchantId, "kuyruk", null, 70000, { mpn: "MPN-1" });
      await client.query(
        `INSERT INTO offer_variant (offer_id, external_id, size_label, gtin, gtin_source)
         VALUES ($1, 'v', '50 ml', '8690000000012', 'feed')`,
        [queued],
      );
      const queuedBare = await offer(otherMerchant, "kuyruk-bos", null, 70000);
      const queuedConflict = await offer(otherMerchant, "kuyruk-catisma", null, 70000, {
        gtin: "8690000000012",
      });

      const candidate = async (offerId: number, productId: number, explain: unknown) => {
        const r = await client.query(
          `INSERT INTO match_candidate (offer_id, product_id, score, method, status, explain, created_at)
           VALUES ($1, $2, 0.7, 'text', 'pending', $3, now() - interval '3 days') RETURNING id`,
          [offerId, productId, explain === null ? null : JSON.stringify(explain)],
        );
        return Number(r.rows[0].id);
      };
      explainedCandidateId = await candidate(queued, rich, {
        version: 1,
        method: "text",
        score: 0.7,
        text_similarity: 0.7,
        review: "renk dogrulanamadi: spring-green",
        auto_eligible: false,
        brand_known_both: true,
        brand_equal: true,
        queue_threshold: 0.63,
        auto_accept_threshold: 0.84,
      });
      bareCandidateId = await candidate(queuedBare, bare, null);
      conflictCandidateId = await candidate(queuedConflict, conflict, null);
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
    });
  });

  async function item(id: number) {
    const items = await listMatchQueue(db, 100);
    const found = items.find((i) => i.matchCandidateId === id);
    if (!found) throw new Error(`aday ${id} kuyrukta yok`);
    return found;
  }

  it("kardeşler sınırlı, canlı toplam ve en düşük fiyat aktif tekliflerden", async () => {
    const { evidence, createdAt } = await item(explainedCandidateId);
    expect(evidence.evidenceAvailable).toBe(true);
    expect(evidence.siblings).toHaveLength(SIBLINGS_PER_PRODUCT);
    expect(evidence.siblingTotal).toBe(10);
    expect(evidence.liveMinPrice).toBe(50000);
    expect(evidence.siblings[0]?.price).toBe(50000);
    expect(evidence.siblings[0]?.variantGtins).toEqual(["8690000000012"]);
    expect(evidence.sameMerchantSibling).toBe(true);
    expect(Date.now() - createdAt.getTime()).toBeGreaterThan(2 * 86_400_000);
  });

  it("kimlik uyumu: ortak varyant barkodu ve ortak MPN", async () => {
    const { evidence } = await item(explainedCandidateId);
    expect(evidence.identifiers?.gtin).toMatchObject({ state: "equal", shared: ["8690000000012"] });
    expect(evidence.identifiers?.mpn.state).toBe("equal");
  });

  it("skor bandı ve inceleme nedeni explain'den", async () => {
    const { evidence } = await item(explainedCandidateId);
    expect(evidence.band).toMatchObject({ position: "review_band", thresholdsFrom: "explain" });
    expect(evidence.humanReasons.join(" ")).toContain("renk dogrulanamadi: spring-green");
    expect(evidence.signals.some((s) => s.key === "review" && s.tone === "weakens")).toBe(true);
  });

  it("açıklamasız eski satır: varsayılan eşikler, kardeşsiz aday, eksik kimlik", async () => {
    const { evidence } = await item(bareCandidateId);
    expect(evidence.band.thresholdsFrom).toBe("default");
    expect(evidence.signals).toEqual([]);
    expect(evidence.humanReasons).toHaveLength(1);
    expect(evidence.siblings).toEqual([]);
    expect(evidence.siblingTotal).toBe(0);
    expect(evidence.identifiers?.gtin.state).toBe("missing");
  });

  it("teklif ve ürün barkodu farklı: çatışma", async () => {
    const { evidence } = await item(conflictCandidateId);
    expect(evidence.identifiers?.gtin.state).toBe("conflict");
  });
});
