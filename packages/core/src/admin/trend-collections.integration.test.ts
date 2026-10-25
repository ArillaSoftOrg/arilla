/**
 * Trend koleksiyonu yönetimi (karar 0149) — gerçek Postgres. Değişiklik ve denetim satırı
 * aynı işlemde; beklenen değer tutmazsa `conflict`; bağlar yalnızca elle seçilmiş trendde;
 * yayın kapısı eşiği işlem içinde denetler. Ürün/teklif satırları hiç değişmez.
 * Tohum satırları benzersiz etiket taşır ve sonunda silinir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { MIN_PUBLIC_TREND_PRODUCTS } from "../trends/types.ts";
import type { AdminActor } from "./capabilities.ts";
import {
  createTrend,
  getTrendEditor,
  searchTrendProducts,
  setTrendCuration,
  setTrendProducts,
  updateTrendDetails,
} from "./trend-collections.ts";
import { listTrendsForAdmin, setTrendStatus } from "./trends-admin.ts";

describe("trend koleksiyonu yönetimi - entegrasyon (karar 0149)", () => {
  let db: Database;
  const tag = `tcol${Date.now().toString(36)}`;
  let admin: AdminActor;
  /** Var olmayan kullanıcı: denetim satırının yabancı anahtarı kırılır. */
  const ghost: AdminActor = { userId: 9_000_000_000_000, role: "admin" };
  const trendIds: number[] = [];
  /** 0..4 gösterilebilir; 5 stoksuz; 6 taslak (yayında değil). */
  const productIds: number[] = [];
  let merchantId = 0;
  let catalogSnapshot = "";

  const details = {
    title: "Sonbahar ve Kış İçin Parfüm Seçme Rehberi",
    description: "Serin havalar için seçki.",
    category: "guzellik",
    trendType: "seasonal",
    heroImageUrl: null,
    activeFrom: null,
    activeUntil: null,
  };

  async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return withOwnerClient(async (client) => (await client.query(text, params)).rows as T[]);
  }
  const links = async (trendId: number) =>
    (
      await q<{ product_id: string }>(
        "SELECT product_id FROM trend_product WHERE trend_id = $1 ORDER BY sort_order",
        [trendId],
      )
    ).map((r) => Number(r.product_id));
  const audits = (trendId: number) =>
    q<{ action: string; before: unknown; after: unknown; reason: string }>(
      `SELECT action, before, after, reason FROM admin_audit_event
        WHERE target_type = 'trend' AND target_id = $1 ORDER BY id`,
      [String(trendId)],
    );
  /** Ürün ve teklif satırlarının özeti: hiçbir işlem bunları değiştirmemeli. */
  const snapshot = async () =>
    (
      await q<{ s: string }>(
        `SELECT md5(coalesce(string_agg(p.id || ':' || p.publication_state || ':' || coalesce(p.min_price, 0)
                 || ':' || p.in_stock_count || ':' || p.updated_at, ',' ORDER BY p.id), '')
                 || coalesce((SELECT string_agg(o.id || ':' || coalesce(o.current_price, 0) || ':' || o.in_stock
                              || ':' || o.is_active, ',' ORDER BY o.id)
                                FROM offer o WHERE o.merchant_id = $2), '')) AS s
           FROM product p WHERE p.id = ANY($1)`,
        [productIds, merchantId],
      )
    )[0]?.s ?? "";

  beforeAll(async () => {
    db = getTestDb();
    const [a] = await q<{ id: string }>(
      "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
      [`${tag}-admin@test.local`],
    );
    admin = { userId: Number(a?.id), role: "admin" };
    const [m] = await q<{ id: string }>(
      `INSERT INTO merchant (slug, name, domain, source_type)
       VALUES ($1, 'Koleksiyon testi', $2, 'user_discovered') RETURNING id`,
      [`${tag}-m`, `${tag}.example`],
    );
    merchantId = Number(m?.id);
    for (let i = 0; i < 7; i++) {
      const draft = i === 6;
      const [p] = await q<{ id: string }>(
        `INSERT INTO product (slug, title, primary_image_url, min_price, max_price, offer_count,
                              in_stock_count, price_updated_at, publication_state,
                              source_merchant_id, source_external_id)
         VALUES ($1, $2, 'https://img.test.example/p.jpg', 150000, 160000, 1, $3,
                 now() - interval '10 days', $4, $5, $6) RETURNING id`,
        [
          `${tag}-urun-${i}`,
          `Koleksiyon parfüm ${tag} ${i}`,
          i === 5 ? 0 : 1,
          draft ? "draft" : "published",
          draft ? merchantId : null,
          draft ? `${tag}-ext-${i}` : null,
        ],
      );
      const productId = Number(p?.id);
      productIds.push(productId);
      const [o] = await q<{ id: string }>(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock,
                            last_seen_at)
         VALUES ($1, $2, $3, 'https://koleksiyon.test.example/u', 't', 150000, $4, now() - interval '9 days')
         RETURNING id`,
        [merchantId, draft ? null : productId, `${tag}-o-${i}`, i !== 5],
      );
      await q("INSERT INTO price_point (offer_id, price, in_stock) VALUES ($1, 150000, true)", [
        o?.id,
      ]);
    }
    catalogSnapshot = await snapshot();
  });

  afterAll(async () => {
    await q("DELETE FROM admin_audit_event WHERE target_type = 'trend' AND target_id = ANY($1)", [
      trendIds.map(String),
    ]);
    await q("DELETE FROM trend WHERE id = ANY($1)", [trendIds]);
    await q(
      "DELETE FROM price_point WHERE offer_id IN (SELECT id FROM offer WHERE merchant_id = $1)",
      [merchantId],
    );
    await q("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
    await q("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    await q("DELETE FROM merchant WHERE id = $1", [merchantId]);
    await q("DELETE FROM app_user WHERE id = $1", [admin.userId]);
  });

  async function newTrend(curation: "manual" | "auto", suffix: string) {
    const result = await createTrend(db, admin, {
      slug: `${tag}-${suffix}`,
      details,
      curation,
      reason: "koleksiyon testi",
    });
    if (result.status !== "created") throw new Error(`oluşturulamadı: ${result.status}`);
    trendIds.push(result.trendId);
    return result.trendId;
  }

  it("oluşturma: taslak, seçilen tür, sıranın sonu, gerekçeli denetim; aynı slug reddedilir", async () => {
    const id = await newTrend("manual", "elle");
    const [row] = await q<{ status: string; curation: string; sort_order: number }>(
      "SELECT status, curation, sort_order, (SELECT max(sort_order) FROM trend) AS top FROM trend WHERE id = $1",
      [id],
    );
    expect(row).toMatchObject({ status: "draft", curation: "manual" });
    const listed = (await listTrendsForAdmin(db, admin, { status: "draft" })).rows.find(
      (r) => r.id === id,
    );
    expect(listed).toMatchObject({ curation: "manual", linkedProducts: 0, visible: false });
    expect(await audits(id)).toMatchObject([
      {
        action: "trends.create",
        after: { slug: `${tag}-elle`, status: "draft", curation: "manual", category: "guzellik" },
        reason: "koleksiyon testi",
      },
    ]);
    expect(
      await createTrend(db, admin, {
        slug: `${tag}-elle`,
        details,
        curation: "auto",
        reason: "ikinci deneme",
      }),
    ).toEqual({ status: "slug_taken" });
  });

  it("ürün bağları: sıralı yazım, aynı liste unchanged, eski beklenen liste conflict", async () => {
    const id = trendIds[0] as number;
    const first = productIds.slice(0, 4);
    expect(
      await setTrendProducts(db, admin, {
        trendId: id,
        productIds: first,
        expectedProductIds: [],
        reason: "ilk seçim",
      }),
    ).toEqual({ status: "updated" });
    expect(await links(id)).toEqual(first);

    const reordered = [first[3], first[0], first[1], first[2]] as number[];
    expect(
      await setTrendProducts(db, admin, {
        trendId: id,
        productIds: reordered,
        expectedProductIds: first,
        reason: "sırayı değiştir",
      }),
    ).toEqual({ status: "updated" });
    expect(await links(id)).toEqual(reordered);

    expect(
      await setTrendProducts(db, admin, {
        trendId: id,
        productIds: reordered,
        expectedProductIds: reordered,
        reason: "aynı liste",
      }),
    ).toEqual({ status: "unchanged" });
    expect(
      await setTrendProducts(db, admin, {
        trendId: id,
        productIds: first,
        expectedProductIds: first, // gerçekte sıra değişti
        reason: "eski sekmeden",
      }),
    ).toEqual({ status: "conflict" });
    expect(await links(id)).toEqual(reordered);
    const rows = await audits(id);
    expect(rows.map((r) => r.action)).toEqual([
      "trends.create",
      "trends.products",
      "trends.products",
    ]);
    expect(rows[2]).toMatchObject({
      before: { productIds: first },
      after: { productIds: reordered },
    });
  });

  it("yayında olmayan ya da var olmayan ürün bağlanmaz", async () => {
    const id = trendIds[0] as number;
    const current = await links(id);
    const result = await setTrendProducts(db, admin, {
      trendId: id,
      productIds: [...current, productIds[6] as number, 9_000_000_000_001],
      expectedProductIds: current,
      reason: "taslak ürün ekle",
    });
    expect(result).toEqual({
      status: "invalid_products",
      productIds: [productIds[6], 9_000_000_000_001],
    });
    expect(await links(id)).toEqual(current);
  });

  it("editör kartı: uyarılar ve eşik; ürün/teklif verisi değişmedi", async () => {
    const id = trendIds[0] as number;
    const editor = await getTrendEditor(db, admin, id, new Date());
    expect(editor).not.toBeNull();
    expect(editor?.products.map((p) => p.id)).toEqual(await links(id));
    expect(editor?.showableProducts).toBe(MIN_PUBLIC_TREND_PRODUCTS);
    expect(editor?.meetsThreshold).toBe(true);
    const card = editor?.products[0];
    expect(card?.showable).toBe(true);
    // Fiyat 10, teklif 9 gün önce; tek fiyat gözlemi; affiliate yok.
    expect(card?.warnings).toEqual([
      "stale_price",
      "stale_offer",
      "thin_price_history",
      "no_affiliate",
    ]);
    expect(await snapshot()).toBe(catalogSnapshot);
  });

  it("ürün araması: katalog aramasıyla aynı (yalnız yayındaki), kartlarıyla", async () => {
    const result = await searchTrendProducts(db, admin, { query: String(productIds[5]) });
    expect(result.rows.map((r) => r.id)).toEqual([productIds[5]]);
    expect(result.rows[0]?.warnings).toContain("out_of_stock");
    expect(result.rows[0]?.showable).toBe(false);
    const draft = await searchTrendProducts(db, admin, { query: String(productIds[6]) });
    expect(draft.rows).toEqual([]);
  });

  it("yayın kapısı: eşik altı yayınlanmaz; eşikte yayınlanır; yayındayken eşik altına düşürülemez", async () => {
    const id = trendIds[0] as number;
    const current = await links(id);
    // Bir ürünü stoksuz olanla değiştir: 3 gösterilebilir.
    const weaker = [...current.slice(0, 3), productIds[5] as number];
    await setTrendProducts(db, admin, {
      trendId: id,
      productIds: weaker,
      expectedProductIds: current,
      reason: "zayıf liste",
    });
    expect(
      await setTrendStatus(db, admin, {
        trendId: id,
        next: "published",
        expectedStatus: "draft",
        reason: "yayın denemesi",
      }),
    ).toEqual({ status: "below_threshold", showable: 3, required: MIN_PUBLIC_TREND_PRODUCTS });
    expect(
      (await q<{ status: string }>("SELECT status FROM trend WHERE id = $1", [id]))[0]?.status,
    ).toBe("draft");

    const strong = [...weaker.slice(0, 3), productIds[4] as number, productIds[5] as number];
    await setTrendProducts(db, admin, {
      trendId: id,
      productIds: strong,
      expectedProductIds: weaker,
      reason: "güçlü liste",
    });
    expect(
      await setTrendStatus(db, admin, {
        trendId: id,
        next: "published",
        expectedStatus: "draft",
        reason: "yayına al",
      }),
    ).toEqual({ status: "updated" });

    expect(
      await setTrendProducts(db, admin, {
        trendId: id,
        productIds: strong.slice(0, 2),
        expectedProductIds: strong,
        reason: "yayındayken boşalt",
      }),
    ).toEqual({ status: "below_threshold", showable: 2, required: MIN_PUBLIC_TREND_PRODUCTS });
    expect(await links(id)).toEqual(strong);
  });

  it("otomatik trendin bağları yazılmaz; manual'a geçince yazılır", async () => {
    const id = await newTrend("auto", "oto");
    const attempt = {
      trendId: id,
      productIds: productIds.slice(0, 4),
      expectedProductIds: [],
      reason: "otomatikte deneme",
    };
    expect(await setTrendProducts(db, admin, attempt)).toEqual({ status: "not_manual" });
    expect(await links(id)).toEqual([]);
    expect(
      await setTrendCuration(db, admin, {
        trendId: id,
        next: "manual",
        expected: "manual", // gerçekte auto
        reason: "eski sekme",
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await setTrendCuration(db, admin, {
        trendId: id,
        next: "manual",
        expected: "auto",
        reason: "editöre geçir",
      }),
    ).toEqual({ status: "updated" });
    expect(await setTrendProducts(db, admin, attempt)).toEqual({ status: "updated" });
    expect((await audits(id)).map((r) => r.action)).toEqual([
      "trends.create",
      "trends.curation",
      "trends.products",
    ]);
  });

  it("ayrıntı düzenleme: yalnız değişen alanlar denetime; eski form conflict; slug değişmez", async () => {
    const id = trendIds[1] as number;
    const next = { ...details, title: "Kış koleksiyonu", activeFrom: "2026-10-01T00:00:00Z" };
    expect(
      await updateTrendDetails(db, admin, {
        trendId: id,
        expected: details,
        next,
        reason: "başlık",
      }),
    ).toEqual({ status: "updated" });
    expect(
      await updateTrendDetails(db, admin, {
        trendId: id,
        expected: details,
        next,
        reason: "tekrar",
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await updateTrendDetails(db, admin, { trendId: id, expected: next, next, reason: "aynısı" }),
    ).toEqual({ status: "unchanged" });
    const last = (await audits(id)).at(-1);
    expect(last).toMatchObject({
      action: "trends.update",
      before: { slug: `${tag}-oto`, title: details.title, activeFrom: null },
      after: { title: "Kış koleksiyonu", activeFrom: "2026-10-01T00:00:00.000Z" },
    });
    expect(Object.keys(last?.after as object).sort()).toEqual(["activeFrom", "title"]);
  });

  it("kayıttaki fazla boşluk formla eşleşir (sonsuz conflict olmaz)", async () => {
    const id = trendIds[1] as number;
    await q("UPDATE trend SET description = $1 WHERE id = $2", ["Serin  havalar\niçin seçki.", id]);
    const editor = await getTrendEditor(db, admin, id);
    expect(editor?.details.description).toBe("Serin havalar için seçki.");
    const expected = { ...details, ...editor?.details };
    expect(
      await updateTrendDetails(db, admin, {
        trendId: id,
        expected,
        next: { ...expected, description: "Yeni açıklama." },
        reason: "boşluk düzeltme",
      }),
    ).toEqual({ status: "updated" });
  });

  it("denetim yazılamazsa bağlar ve ayrıntılar geri alınır (atomik)", async () => {
    const id = trendIds[1] as number;
    const current = await links(id);
    await expect(
      setTrendProducts(db, ghost, {
        trendId: id,
        productIds: current.slice(0, 1),
        expectedProductIds: current,
        reason: "geri alma denemesi",
      }),
    ).rejects.toThrow();
    expect(await links(id)).toEqual(current);
    await expect(
      setTrendCuration(db, ghost, {
        trendId: id,
        next: "auto",
        expected: "manual",
        reason: "geri alma denemesi",
      }),
    ).rejects.toThrow();
    expect(
      (await q<{ curation: string }>("SELECT curation FROM trend WHERE id = $1", [id]))[0]
        ?.curation,
    ).toBe("manual");
  });

  it("eşzamanlı iki kayıt aynı listeyi görmüşse yalnızca biri yazar", async () => {
    const id = trendIds[1] as number;
    const current = await links(id);
    const a = [...current].reverse();
    const b = [...current.slice(1), current[0] as number];
    const results = await Promise.all([
      setTrendProducts(db, admin, {
        trendId: id,
        productIds: a,
        expectedProductIds: current,
        reason: "sekme A",
      }),
      setTrendProducts(db, admin, {
        trendId: id,
        productIds: b,
        expectedProductIds: current,
        reason: "sekme B",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "updated"]);
    const final = await links(id);
    expect([JSON.stringify(a), JSON.stringify(b)]).toContain(JSON.stringify(final));
  });

  it("arşivdeki trendin bağları değişmez", async () => {
    const id = trendIds[1] as number;
    await setTrendStatus(db, admin, {
      trendId: id,
      next: "archived",
      expectedStatus: "draft",
      reason: "arşivle",
    });
    const current = await links(id);
    expect(
      await setTrendProducts(db, admin, {
        trendId: id,
        productIds: [],
        expectedProductIds: current,
        reason: "arşivde boşalt",
      }),
    ).toEqual({ status: "archived" });
    expect(await snapshot()).toBe(catalogSnapshot);
  });
});
