/**
 * Arama tanısının arama motoru tarafı (karar 0054), gerçek yerel Postgres:
 * - tanı sırası `/ara`'nın `search()` sırasıyla birebir aynı; skor çarpanların çarpımı
 * - aday kapıları sayıları
 * - "bu ürün neden yok": her neden ölçülen bir kapıdan gelir
 * - tanı hiçbir şey yazmaz (`search_query_day`, `query_resolution`)
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { explainProductAbsence, explainSearch } from "../admin/search-diagnostics.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { search } from "./search.ts";
import { candidateFunnel, probeProduct, rankWithFactors } from "./search-explain.ts";
import type { QueryObject } from "./types.ts";

const suffix = Date.now().toString(36);
const WORD = `qbt${suffix}`;

function query(overrides: Partial<QueryObject> = {}): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: WORD,
    filters: {},
    style_tags: [],
    sort: "balanced",
    unparsed: WORD,
    confidence: 0,
    ...overrides,
  };
}

describe("arama tanısı motoru - entegrasyon", () => {
  let db: Database;
  const ids: Record<string, number> = {};
  const merchants: number[] = [];
  let moderator: AdminActor;
  let plainUser: AdminActor;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const m = await client.query(
        `INSERT INTO app_user (email, role) VALUES ($1, 'moderator'), ($2, 'user') RETURNING id`,
        [`s2-mod-${suffix}@test.local`, `s2-user-${suffix}@test.local`],
      );
      moderator = { userId: Number(m.rows[0].id), role: "moderator" };
      plainUser = { userId: Number(m.rows[1].id), role: "user" };

      const active = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
         VALUES ($1, 'S2 Aktif', $2, 'xml_feed', 80) RETURNING id`,
        [`s2-aktif-${suffix}`, `s2a-${suffix}.test`],
      );
      const passive = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, trust_score, is_active)
         VALUES ($1, 'S2 Pasif', $2, 'xml_feed', 80, FALSE) RETURNING id`,
        [`s2-pasif-${suffix}`, `s2p-${suffix}.test`],
      );
      const activeId = Number(active.rows[0].id);
      const passiveId = Number(passive.rows[0].id);
      merchants.push(activeId, passiveId);

      // key, title, min_price, image, offers: [merchant, price, inStock, isActive]
      const fixtures: [
        string,
        string,
        number,
        string | null,
        [number, number, boolean, boolean][],
      ][] = [
        [
          "a",
          `Kırmızı ${WORD} Bot`,
          100_000,
          `https://img.test/${suffix}/a.jpg`,
          [[activeId, 100_000, true, true]],
        ],
        [
          "b",
          `Mavi ${WORD} Bot`,
          200_000,
          `https://img.test/${suffix}/b.jpg`,
          [[activeId, 200_000, false, true]],
        ],
        [
          "c",
          `Kopya ${WORD} Bot`,
          150_000,
          `https://img.test/${suffix}/a.jpg`,
          [[activeId, 150_000, false, true]],
        ],
        ["d", `Eski ${WORD} Bot`, 100_000, null, [[activeId, 100_000, true, false]]],
        ["e", `Pasif ${WORD} Bot`, 100_000, null, [[passiveId, 100_000, true, true]]],
        ["f", `Sandalet ${suffix}x`, 100_000, null, [[activeId, 100_000, true, true]]],
        ["g", `Pahalı ${WORD} Bot`, 900_000, null, [[activeId, 900_000, true, true]]],
      ];
      let ext = 0;
      for (const [key, title, minPrice, image, offers] of fixtures) {
        const p = await client.query(
          `INSERT INTO product (slug, title, min_price, primary_image_url, offer_count)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [`s2-${key}-${suffix}`, title, minPrice, image, offers.length],
        );
        ids[key] = Number(p.rows[0].id);
        for (const [merchantId, price, inStock, isActive] of offers) {
          ext += 1;
          await client.query(
            `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              merchantId,
              ids[key],
              `s2-${suffix}-${ext}`,
              `https://s2-${suffix}.test/${ext}`,
              title,
              price,
              inStock,
              isActive,
            ],
          );
        }
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM offer WHERE merchant_id = ANY($1)", [merchants]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [Object.values(ids)]);
      await client.query("DELETE FROM merchant WHERE id = ANY($1)", [merchants]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [moderator.userId, plainUser.userId],
      ]);
    });
  });

  it("tanı sırası search() ile aynı; skor çarpanların çarpımı", async () => {
    for (const sort of ["balanced", "best_deal"] as const) {
      for (const q of [
        query({ sort }),
        query({ sort, unparsed: "", text: "", filters: { price_max: 500_000 } }),
      ]) {
        const real = await search(db, q, { limit: 50 });
        const explained = await rankWithFactors(db, q, sort, 50);
        expect(explained.items.map((i) => i.productId)).toEqual(real.items.map((i) => i.productId));
        expect(explained.total).toBe(real.total);
        expect(explained.items.map((i) => i.score)).toEqual(real.items.map((i) => i.score));
      }
    }
    const balanced = await rankWithFactors(db, query(), "balanced", 50);
    for (const item of balanced.items) {
      const f = item.factors;
      expect((f.relevance ?? 0) * (f.trust ?? 0) * (f.stock ?? 0) * (f.price ?? 0)).toBeCloseTo(
        item.score,
        9,
      );
    }
    const a = balanced.items.find((i) => i.productId === ids.a);
    expect(a?.factors).toMatchObject({ trust: 0.8, stock: 1, price: 0.5 });
    expect(a?.rank).toBe(1);
  });

  it("aday kapıları: ön filtre → aktif teklif → metin → filtre → görsel", async () => {
    const funnel = await candidateFunnel(
      db,
      query({ filters: { price_max: 500_000 } }),
      "balanced",
    );
    expect(funnel.textSlots).toEqual([[WORD]]);
    expect(funnel.prefilter).toBe(6); // f metni taşımıyor
    expect(funnel.withActiveOffer).toBe(4); // d pasif teklif, e pasif mağaza
    expect(funnel.textGate).toBe(4);
    expect(funnel.filters).toBe(3); // g fiyat üstü
    expect(funnel.filterRejects.find((r) => r.name === "price_max")?.rejected).toBe(1);
    expect(funnel.afterImageDedup).toBe(2); // a ve c aynı görsel
    const real = await search(db, query({ filters: { price_max: 500_000 } }), { limit: 50 });
    expect(real.total).toBe(funnel.afterImageDedup);
  });

  it("probeProduct: her ürünün nedeni ölçülen kapıdan", async () => {
    const q = query({ filters: { price_max: 500_000 } });
    const a = await probeProduct(db, q, "balanced", ids.a as number);
    expect(a?.rank).toBe(1);
    expect(a?.total).toBe(2);

    const c = await probeProduct(db, q, "balanced", ids.c as number);
    expect(c?.rank).toBeNull();
    expect(c?.inCandidates).toBe(true);
    expect(c?.hiddenByImageOf?.productId).toBe(ids.a);

    const d = await probeProduct(db, q, "balanced", ids.d as number);
    expect(d?.offers).toMatchObject({ total: 1, active: 0 });
    expect(d?.hasBestOffer).toBe(false);

    const e = await probeProduct(db, q, "balanced", ids.e as number);
    expect(e?.offers).toMatchObject({ active: 1, activeOnActiveMerchant: 0 });

    const f = await probeProduct(db, q, "balanced", ids.f as number);
    expect(f?.prefilterPass).toBe(false);
    expect(f?.textGatePass).toBe(false);

    const g = await probeProduct(db, q, "balanced", ids.g as number);
    expect(g?.textGatePass).toBe(true);
    expect(g?.predicates.find((p) => p.name === "price_max")?.pass).toBe(false);

    expect(await probeProduct(db, q, "balanced", 999_999_999)).toBeNull();
  });

  it("explainSearch + explainProductAbsence: moderatör kullanır, kullanıcı reddedilir, hiçbir şey yazılmaz", async () => {
    const counts = () =>
      withOwnerClient(async (client) => {
        const r = await client.query(
          `SELECT (SELECT count(*) FROM search_query_day)::int AS sq,
                  (SELECT count(*) FROM query_resolution)::int AS qr,
                  (SELECT COALESCE(sum(hit_count), 0)::int FROM query_resolution) AS hits`,
        );
        return r.rows[0];
      });
    const before = await counts();

    const d = await explainSearch(db, moderator, WORD);
    expect(d.results[0]?.productId).toBe(ids.a);
    expect(d.results[0]?.factors?.trust).toBeCloseTo(0.8);
    expect(d.funnel.withActiveOffer).toBe(4);

    const absent = await explainProductAbsence(db, moderator, WORD, `s2-d-${suffix}`);
    expect(absent.probe?.productId).toBe(ids.d);
    expect(absent.reasons.map((r) => r.code)).toEqual(["no_active_offer"]);

    const present = await explainProductAbsence(db, moderator, WORD, String(ids.a));
    expect(present.probe?.rank).toBe(1);
    expect(present.reasons).toEqual([]);

    const missing = await explainProductAbsence(db, moderator, WORD, "yok-boyle-bir-urun");
    expect(missing.probe).toBeNull();

    expect(await counts()).toEqual(before);

    await expect(explainSearch(db, plainUser, WORD)).rejects.toBeInstanceOf(AdminForbiddenError);
    await expect(explainProductAbsence(db, plainUser, WORD, "1")).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });
});
