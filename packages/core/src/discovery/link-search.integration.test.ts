/**
 * Link araması (docs/decisions/0031) - gerçek Postgres. Redis gerektirmez:
 * önbellek isabetleri kuyruğa hiç gitmez, limit kontrolü de kuyruktan önce
 * çalışır. Satırlar bu testin kendi adres ön ekiyle açılır ve silinir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { enqueueLinkResolution, LinkSearchLimitError } from "./link-resolution.ts";
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
const denyLimit = async () => ({ allowed: false });

describe("link search - integration", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it("reuses a resolved result across sessions without counting the limit", async () => {
    const id = await insertRequest({
      path: "/urun/cozuldu",
      status: "resolved",
      finishedMinutesAgo: 30,
      source: { site: "link-arama-entegrasyon.example", title: "Deri Çanta" },
    });
    // Tracking parametresi ve fragment önbellek anahtarını değiştirmez.
    const result = await enqueueLinkResolution(db, input("/urun/cozuldu?utm_source=x#a"), {
      checkLimit: denyLimit,
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
      enqueueLinkResolution(db, input("/urun/eski-hata"), { checkLimit: denyLimit }),
    ).rejects.toBeInstanceOf(LinkSearchLimitError);
  });

  it("does not cache transient infrastructure failures", async () => {
    await insertRequest({
      path: "/urun/kuyruk",
      status: "failed",
      finishedMinutesAgo: 1,
      errorCode: "queue_unavailable",
    });
    await expect(
      enqueueLinkResolution(db, input("/urun/kuyruk"), { checkLimit: denyLimit }),
    ).rejects.toBeInstanceOf(LinkSearchLimitError);
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
});
