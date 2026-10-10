/**
 * Link araması (docs/decisions/0035) - gerçek Postgres. Redis gerektirmez:
 * önbellek isabetleri kuyruğa hiç gitmez, limit kontrolü de kuyruktan önce
 * çalışır. Satırlar bu testin kendi adres ön ekiyle açılır ve silinir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateLexiconCache } from "../search/lexicon-cache.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { enqueueLinkResolution } from "./link-resolution.ts";
import { findLinkSearchResults, getLinkSearchState } from "./link-search.ts";

const HOST = "https://link-arama-entegrasyon.example";

async function cleanup(): Promise<void> {
  await withOwnerClient((client) =>
    client.query("DELETE FROM link_resolution_request WHERE normalized_url LIKE $1", [`${HOST}%`]),
  );
}

async function insertRequest(values: {
  path: string;
  status: "queued" | "processing" | "resolved" | "failed";
  finishedMinutesAgo?: number;
  createdMinutesAgo?: number;
  errorCode?: string | null;
  source?: Record<string, unknown> | null;
  imageEmbeddingId?: number | null;
}): Promise<string> {
  const url = `${HOST}${values.path}`;
  const created = values.createdMinutesAgo ?? values.finishedMinutesAgo ?? 0;
  return withOwnerClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO link_resolution_request
         (url_raw, normalized_url, session_id, status, error_code, source, image_embedding_id,
          created_at, finished_at)
       VALUES ($1, $1, 'entegrasyon', $2, $3, $4, $5,
               now() - make_interval(mins => $6::int),
               CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(mins => $7::int) END)
       RETURNING id`,
      [
        url,
        values.status,
        values.errorCode ?? null,
        values.source ? JSON.stringify(values.source) : null,
        values.imageEmbeddingId ?? null,
        created,
        values.finishedMinutesAgo ?? null,
      ],
    );
    return result.rows[0]?.id ?? "";
  });
}

const input = (path: string) => ({
  urlRaw: `${HOST}${path}`,
  sessionId: "baska-oturum",
  userId: null,
});
/**
 * YENI istek acilacagini kanitlar: `onRequestCreated` yalnizca yeni satirda
 * cagrilir (0047 hak kaydi buraya baglanir). Kuyruga yazmadan durdurur.
 */
class NewRequestOpened extends Error {}
const refuseNewRequest = async () => {
  throw new NewRequestOpened();
};

describe("link search - integration", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it("reuses a resolved result across sessions without opening a new request", async () => {
    const id = await insertRequest({
      path: "/urun/cozuldu",
      status: "resolved",
      finishedMinutesAgo: 30,
      source: { site: "link-arama-entegrasyon.example", title: "Deri Çanta" },
    });
    // Tracking parametresi ve fragment önbellek anahtarını değiştirmez.
    const result = await enqueueLinkResolution(db, input("/urun/cozuldu?utm_source=x#a"), {
      onRequestCreated: refuseNewRequest,
    });
    expect(result).toEqual({ requestId: id, reused: true });
  });

  it("remembers a recent failure (negative cache) but not a stale one", async () => {
    const recent = await insertRequest({
      path: "/urun/429",
      status: "failed",
      finishedMinutesAgo: 2,
      errorCode: "rate_limited",
    });
    expect(await enqueueLinkResolution(db, input("/urun/429"))).toEqual({
      requestId: recent,
      reused: true,
    });

    await insertRequest({
      path: "/urun/eski-hata",
      status: "failed",
      finishedMinutesAgo: 60,
      errorCode: "rate_limited",
    });
    await expect(
      enqueueLinkResolution(db, input("/urun/eski-hata"), { onRequestCreated: refuseNewRequest }),
    ).rejects.toBeInstanceOf(NewRequestOpened);
  });

  it("does not cache transient infrastructure failures", async () => {
    await insertRequest({
      path: "/urun/kuyruk",
      status: "failed",
      finishedMinutesAgo: 1,
      errorCode: "queue_unavailable",
    });
    await expect(
      enqueueLinkResolution(db, input("/urun/kuyruk"), { onRequestCreated: refuseNewRequest }),
    ).rejects.toBeInstanceOf(NewRequestOpened);
  });

  it("treats a stuck in-flight request as dead so the UI never waits forever", async () => {
    const fresh = await insertRequest({ path: "/urun/isleniyor", status: "processing" });
    expect((await getLinkSearchState(db, `${HOST}/urun/isleniyor`)).kind).toBe("pending");
    expect(await enqueueLinkResolution(db, input("/urun/isleniyor"))).toEqual({
      requestId: fresh,
      reused: true,
    });

    await insertRequest({ path: "/urun/takildi", status: "processing", createdMinutesAgo: 15 });
    expect((await getLinkSearchState(db, `${HOST}/urun/takildi`)).kind).toBe("none");
  });

  it("rejects internal destinations before touching the database", async () => {
    await expect(
      enqueueLinkResolution(db, {
        urlRaw: "http://169.254.169.254/x",
        sessionId: "s",
        userId: null,
      }),
    ).rejects.toThrow();
  });

  it("finds visually similar catalog products and never labels them the same product", async () => {
    const anchor = await db.execute<{
      embedding_id: string;
      product_id: string;
      title: string;
    }>(sql`
      SELECT e.id AS embedding_id, o.product_id, p.title
      FROM embedding e
      JOIN offer o ON o.id = e.target_id
      JOIN product p ON p.id = o.product_id
      WHERE e.target_type = 'offer' AND e.kind = 'image' AND p.offer_count > 0
      ORDER BY e.id LIMIT 1
    `);
    const row = anchor.rows[0];
    if (!row) return; // katalog boş: görsel yolu burada doğrulanamaz

    await insertRequest({
      path: "/urun/gorselli",
      status: "resolved",
      finishedMinutesAgo: 1,
      source: { site: "link-arama-entegrasyon.example", title: row.title },
      imageEmbeddingId: Number(row.embedding_id),
    });
    const state = await getLinkSearchState(db, `${HOST}/urun/gorselli`);
    expect(state.kind).toBe("resolved");
    if (state.kind !== "resolved") return;

    const results = await findLinkSearchResults(db, state);
    expect(results.signals.image).toBe(true);
    expect(results.same).toEqual([]);
    // Aynı görselin ürünü en üstte, benzerlik azalan sırada.
    expect(results.similar[0]?.productId).toBe(Number(row.product_id));
    for (let i = 1; i < results.similar.length; i++) {
      expect(results.similar[i - 1]?.score).toBeGreaterThanOrEqual(results.similar[i]?.score ?? 0);
    }
  });

  it("uses a barcode match as same-product evidence", async () => {
    const withGtin = await db.execute<{ id: string; gtin: string }>(sql`
      SELECT id, gtin FROM product WHERE gtin IS NOT NULL AND offer_count > 0 ORDER BY id LIMIT 1
    `);
    const row = withGtin.rows[0];
    if (!row) return;

    await insertRequest({
      path: "/urun/barkodlu",
      status: "resolved",
      finishedMinutesAgo: 1,
      source: { site: "link-arama-entegrasyon.example", title: "Başka bir başlık", gtin: row.gtin },
    });
    const state = await getLinkSearchState(db, `${HOST}/urun/barkodlu`);
    if (state.kind !== "resolved") throw new Error("resolved bekleniyordu");
    const results = await findLinkSearchResults(db, state);
    expect(results.same.map((item) => [item.productId, item.evidence])).toContainEqual([
      Number(row.id),
      "gtin",
    ]);
    expect(results.similar.some((item) => item.productId === Number(row.id))).toBe(false);
  });

  it("returns nothing rather than filler when no signal matches", async () => {
    await insertRequest({
      path: "/urun/eslesmez",
      status: "resolved",
      finishedMinutesAgo: 1,
      source: { site: "link-arama-entegrasyon.example", title: "Qzxv Wplk Jjrr" },
    });
    const state = await getLinkSearchState(db, `${HOST}/urun/eslesmez`);
    if (state.kind !== "resolved") throw new Error("resolved bekleniyordu");
    const results = await findLinkSearchResults(db, state);
    expect(results.same).toEqual([]);
    expect(results.similar).toEqual([]);
    expect(results.signals).toEqual({ image: false, text: false, identity: false });
  });

  describe("preferences (decision 0090)", () => {
    const tag = "linkpref-entegrasyon";
    const SRC_TITLE = "Zorvanta Kapsül Mont";
    const NOCOLOR_TITLE = "Qelmora Sentil Kolye";
    const ids: Record<string, number> = {};
    let merchantId = 0;
    const categoryIds: number[] = [];

    async function seedProduct(
      client: import("pg").Client,
      key: string,
      title: string,
      values: {
        color?: string | null;
        attributes?: Record<string, unknown>;
        price?: number | null;
        categoryId?: number | null;
      },
    ): Promise<void> {
      const p = await client.query<{ id: string }>(
        `INSERT INTO product (slug, title, color, attributes, category_id, primary_image_url, offer_count)
         VALUES ($1, $2, $3, $4, $5, 'https://lp.test/p.jpg', 1) RETURNING id`,
        [
          `${tag}-${key}`,
          title,
          values.color ?? null,
          JSON.stringify(values.attributes ?? {}),
          values.categoryId ?? null,
        ],
      );
      const productId = Number(p.rows[0]?.id);
      ids[key] = productId;
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, is_active,
                            current_price)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          merchantId,
          productId,
          `${tag}-${key}`,
          `https://lp.test/${key}`,
          title,
          values.price ?? null,
        ],
      );
    }

    async function cleanupPreferenceRows(): Promise<void> {
      await withOwnerClient(async (client) => {
        await client.query(
          "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = $1)",
          [tag],
        );
        await client.query("DELETE FROM product WHERE slug LIKE $1", [`${tag}-%`]);
        await client.query("DELETE FROM merchant WHERE slug = $1", [tag]);
        await client.query("DELETE FROM lexicon WHERE surface = 'zzlinkprefmont'");
        await client.query("DELETE FROM category WHERE slug LIKE $1", [`${tag}-%`]);
      });
      invalidateLexiconCache(db);
    }

    async function resolvedState(path: string, title: string, category?: string) {
      await insertRequest({
        path,
        status: "resolved",
        finishedMinutesAgo: 1,
        source: {
          site: "link-arama-entegrasyon.example",
          title,
          ...(category ? { category } : {}),
        },
      });
      const state = await getLinkSearchState(db, `${HOST}${path}`);
      if (state.kind !== "resolved") throw new Error("resolved bekleniyordu");
      return state;
    }

    const idsOf = (items: { productId: number }[]) => items.map((item) => item.productId);
    const sortedIds = (...keys: string[]) => keys.map((key) => Number(ids[key])).sort();

    beforeAll(async () => {
      await cleanupPreferenceRows();
      await withOwnerClient(async (client) => {
        const m = await client.query<{ id: string }>(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $1, 'linkpref.test', 'xml_feed', true) RETURNING id`,
          [tag],
        );
        merchantId = Number(m.rows[0]?.id);
        for (const leaf of ["mont", "canta"]) {
          const c = await client.query<{ id: string }>(
            "INSERT INTO category (slug, name, path) VALUES ($1, $2, $3) RETURNING id",
            [`${tag}-${leaf}`, leaf, `zzlinkpref/${leaf}`],
          );
          categoryIds.push(Number(c.rows[0]?.id));
        }
        await client.query(
          "INSERT INTO lexicon (kind, surface, normalized) VALUES ('category', 'zzlinkprefmont', 'zzlinkpref/mont')",
        );
        const [mont, canta] = categoryIds;
        await seedProduct(client, "a", `${SRC_TITLE} Siyah`, {
          color: "black",
          price: 50_000,
          categoryId: mont,
          attributes: { style: "spor" },
        });
        await seedProduct(client, "b", `${SRC_TITLE} Bej`, {
          color: "beige",
          price: 150_000,
          categoryId: mont,
          attributes: { material: "deri" },
        });
        await seedProduct(client, "c", `${SRC_TITLE} Koyu`, {
          color: "black",
          price: 90_000,
          categoryId: mont,
        });
        await seedProduct(client, "d", `${SRC_TITLE} Renksiz`, { price: null, categoryId: mont });
        await seedProduct(client, "wrongcat", `${SRC_TITLE} Çantası`, {
          color: "black",
          price: 10_000,
          categoryId: canta,
        });
        await seedProduct(client, "n1", `${NOCOLOR_TITLE} Gümüş`, { price: 20_000 });
        await seedProduct(client, "n2", `${NOCOLOR_TITLE} Altın`, { price: 40_000 });
      });
      invalidateLexiconCache(db);
    });

    afterAll(cleanupPreferenceRows);

    it("returns the identical result plus an empty outcome without preferences", async () => {
      const state = await resolvedState("/pref/tercihsiz", SRC_TITLE);
      const plain = await findLinkSearchResults(db, state);
      const empty = await findLinkSearchResults(db, state, {});
      expect(plain.preferences).toEqual({ applied: [], unapplied: [], droppedByPreferences: 0 });
      expect(empty).toEqual(plain);
      expect(idsOf(plain.similar).sort()).toEqual(
        expect.arrayContaining(sortedIds("a", "b", "c", "d", "wrongcat")),
      );
      for (const item of plain.similar) expect(item).not.toHaveProperty("color");
    });

    it("filters by price range and drops candidates with an unknown price", async () => {
      const state = await resolvedState("/pref/fiyat", SRC_TITLE);
      const result = await findLinkSearchResults(db, state, {
        priceMinKurus: 40_000,
        priceMaxKurus: 100_000,
      });
      expect(idsOf(result.similar).sort()).toEqual(sortedIds("a", "c"));
      expect(result.preferences.applied).toEqual(["price"]);
      expect(result.preferences.droppedByPreferences).toBeGreaterThan(0);
    });

    it("sorts the eligible candidates by ascending price for cheapest", async () => {
      const state = await resolvedState("/pref/ucuz", SRC_TITLE);
      const result = await findLinkSearchResults(db, state, { sort: "cheapest" });
      const prices = result.similar.map((item) => item.minPrice).filter((v) => v !== null);
      expect(prices).toEqual([...prices].sort((x, y) => (x ?? 0) - (y ?? 0)));
      expect(result.preferences.applied).toContain("sort");
      expect(idsOf(result.similar)[0]).toBe(Number(ids.wrongcat));
    });

    it("filters by color and exposes it on the items", async () => {
      const state = await resolvedState("/pref/renk", SRC_TITLE);
      const result = await findLinkSearchResults(db, state, { colors: ["black"] });
      expect(idsOf(result.similar).sort()).toEqual(sortedIds("a", "c", "wrongcat"));
      expect(result.similar.every((item) => item.color === "black")).toBe(true);
      expect(result.preferences.applied).toEqual(["color"]);
    });

    it("leaves the color preference unapplied when the pool has no color data", async () => {
      const state = await resolvedState("/pref/renksiz-havuz", NOCOLOR_TITLE);
      const result = await findLinkSearchResults(db, state, { colors: ["black"] });
      expect(idsOf(result.similar).sort()).toEqual(sortedIds("n1", "n2"));
      expect(result.preferences).toEqual({
        applied: [],
        unapplied: ["color"],
        droppedByPreferences: 0,
      });
    });

    it("filters by style from attributes and never invents it", async () => {
      const state = await resolvedState("/pref/stil", SRC_TITLE);
      const result = await findLinkSearchResults(db, state, { styles: ["spor"] });
      expect(idsOf(result.similar)).toEqual([Number(ids.a)]);
      expect(result.preferences.applied).toEqual(["style"]);

      const noData = await resolvedState("/pref/stil-yok", NOCOLOR_TITLE);
      const none = await findLinkSearchResults(db, noData, { styles: ["spor"] });
      expect(none.preferences.unapplied).toEqual(["style"]);
      expect(none.similar).toHaveLength(2);
    });

    it("gates by category only when the source category maps reliably", async () => {
      const gated = await resolvedState("/pref/kategori", SRC_TITLE, "zzlinkprefmont");
      const result = await findLinkSearchResults(db, gated, { sort: "cheapest" });
      expect(idsOf(result.similar)).not.toContain(Number(ids.wrongcat));
      expect(idsOf(result.similar)).toContain(Number(ids.a));

      const unknown = await resolvedState("/pref/kategori-yok", SRC_TITLE, "Bilinmeyen Raf");
      const open = await findLinkSearchResults(db, unknown, { sort: "cheapest" });
      expect(idsOf(open.similar)).toContain(Number(ids.wrongcat));
    });
  });
});
