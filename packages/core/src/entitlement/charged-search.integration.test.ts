/**
 * Hak harcayan fotograf ve link aramasi - gercek Postgres + Redis
 * (docs/decisions/0046). Saglayici sahte istemcidir; ag cagrisi yapilmaz.
 * Link kuyrugu gercek Redis'e yazar: testleri ayri bir Redis veritabaninda
 * calistirin (`REDIS_URL=redis://localhost:6379/<n>`).
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@arilla/db";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "../account/delete-account.ts";
import { LINK_RESOLUTION_QUEUE_KEY } from "../discovery/link-resolution.ts";
import type { EmbeddingClient } from "../embedding/client.ts";
import { type PreparedImage, preprocessImage } from "../embedding/preprocess-image.ts";
import { getRedis } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getCharge } from "./charge.ts";
import { runChargedLinkSearch, runChargedVisualSearch } from "./charged-search.ts";
import { reconcileLinkRequestCharge } from "./reconcile.ts";
import { getEntitlementStatus } from "./status.ts";

const tag = `chs-${Date.now()}`;
const created: number[] = [];

async function newUser(): Promise<number> {
  return withOwnerClient(async (client) => {
    const res = await client.query<{ id: string }>(
      "INSERT INTO app_user (email) VALUES ($1) RETURNING id",
      [`${tag}-${randomUUID().slice(0, 8)}@example.test`],
    );
    const id = Number(res.rows[0]?.id);
    created.push(id);
    return id;
  });
}

async function owner<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return withOwnerClient(async (client) => (await client.query(text, params)).rows as T[]);
}

function vector(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === seed % 768 ? 1 : 0));
}

function fakeClient(mode: "ok" | "fail"): EmbeddingClient & { calls: number } {
  const client = {
    modelVersion: "fake-v1",
    calls: 0,
    async embedImage() {
      client.calls++;
      if (mode === "fail") throw new Error("upstream 503");
      return { vector: vector(client.calls), modelVersion: "fake-v1", tokens: 10 };
    },
  };
  return client;
}

let imageSeed = 0;
async function uniqueImage(): Promise<PreparedImage> {
  imageSeed++;
  const buffer = await sharp({
    create: {
      width: 64 + imageSeed,
      height: 64,
      channels: 3,
      background: { r: (Date.now() + imageSeed * 37) % 255, g: imageSeed % 255, b: 90 },
    },
  })
    .jpeg()
    .toBuffer();
  return preprocessImage(buffer);
}

describe("hak harcayan arama - entegrasyon", () => {
  let db: Database;
  const pushedRequestIds: string[] = [];

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    for (const id of pushedRequestIds) {
      await getRedis().lrem(LINK_RESOLUTION_QUEUE_KEY, 0, JSON.stringify({ request_id: id }));
    }
    // Gercek silme yolu: api_usage/image_upload kimliksizlestirilir, hak
    // tablolari CASCADE ile gider.
    for (const id of created) await deleteAccount(db, id);
    await owner("DELETE FROM link_resolution_request WHERE session_id = $1", [tag]);
  });

  describe("fotograf", () => {
    it("basarili saglayici cagrisi bir hak harcar ve kesinlesir", async () => {
      const user = await newUser();
      const client = fakeClient("ok");
      const result = await runChargedVisualSearch(
        db,
        { userId: user, sessionId: tag, requestKey: randomUUID(), prepared: await uniqueImage() },
        client,
      );
      expect(result.status).toBe("ok");
      expect(client.calls).toBe(1);
      const [charge] = await owner<{ state: string; image_upload_id: string }>(
        "SELECT state, image_upload_id FROM ai_search_charge WHERE user_id = $1",
        [user],
      );
      expect(charge?.state).toBe("settled");
      if (result.status === "ok")
        expect(Number(charge?.image_upload_id)).toBe(result.imageUploadId);
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(1);
    });

    it("embedding onbellek isabeti de bir hak harcar", async () => {
      const user = await newUser();
      const prepared = await uniqueImage();
      const client = fakeClient("ok");
      await runChargedVisualSearch(
        db,
        { userId: user, sessionId: tag, requestKey: randomUUID(), prepared },
        client,
      );
      const second = await runChargedVisualSearch(
        db,
        { userId: user, sessionId: tag, requestKey: randomUUID(), prepared },
        client,
      );
      expect(second.status).toBe("ok");
      expect(client.calls).toBe(1); // ikinci cagri onbellekten
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(2);
    });

    it("saglayici hatasi hakki tam bir kez iade eder ve hatayi iletir", async () => {
      const user = await newUser();
      await expect(
        runChargedVisualSearch(
          db,
          { userId: user, sessionId: tag, requestKey: randomUUID(), prepared: await uniqueImage() },
          fakeClient("fail"),
        ),
      ).rejects.toThrow();
      const [charge] = await owner<{ state: string; refund_reason: string }>(
        "SELECT state, refund_reason FROM ai_search_charge WHERE user_id = $1",
        [user],
      );
      expect(charge).toEqual({ state: "refunded", refund_reason: "provider_error" });
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(0);
    });

    it("ayni istek anahtari (cift gonderim) saglayiciyi ikinci kez cagirmaz", async () => {
      const user = await newUser();
      const requestKey = randomUUID();
      const prepared = await uniqueImage();
      const client = fakeClient("ok");
      const first = await runChargedVisualSearch(
        db,
        { userId: user, sessionId: tag, requestKey, prepared },
        client,
      );
      const again = await runChargedVisualSearch(
        db,
        { userId: user, sessionId: tag, requestKey, prepared },
        client,
      );
      expect(again).toEqual(first);
      expect(client.calls).toBe(1);
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(1);
    });

    it("hak bitince saglayiciya gitmez", async () => {
      const user = await newUser();
      await owner(
        `INSERT INTO ai_quota_day (user_id, day, daily_limit, used)
         VALUES ($1, (now() AT TIME ZONE 'Europe/Istanbul')::date, 10, 10)`,
        [user],
      );
      const client = fakeClient("ok");
      const result = await runChargedVisualSearch(
        db,
        { userId: user, sessionId: tag, requestKey: randomUUID(), prepared: await uniqueImage() },
        client,
      );
      expect(result.status).toBe("no_rights");
      expect(client.calls).toBe(0);
    });

    it("dakikada 4. istek oran sinirina takilir ve hak harcamaz", async () => {
      const user = await newUser();
      const client = fakeClient("ok");
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) {
        const result = await runChargedVisualSearch(
          db,
          { userId: user, sessionId: tag, requestKey: randomUUID(), prepared: await uniqueImage() },
          client,
        );
        statuses.push(result.status);
      }
      expect(statuses).toEqual(["ok", "ok", "ok", "rate_limited"]);
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(3);
    });
  });

  describe("link", () => {
    const url = (n: number) => `https://magaza-${tag}.example/urun/${n}`;

    it("yeni is bir hak harcar; ayni link baskasina ucretsizdir; resolved kesinlesir", async () => {
      const owner1 = await newUser();
      const other = await newUser();
      const first = await runChargedLinkSearch(db, {
        userId: owner1,
        sessionId: tag,
        requestKey: randomUUID(),
        urlRaw: url(1),
      });
      expect(first).toMatchObject({ status: "queued", reused: false });
      if (first.status !== "queued") throw new Error(first.status);
      pushedRequestIds.push(first.requestId);

      const reused = await runChargedLinkSearch(db, {
        userId: other,
        sessionId: tag,
        requestKey: randomUUID(),
        urlRaw: url(1),
      });
      expect(reused).toMatchObject({ status: "queued", reused: true, requestId: first.requestId });
      expect((await getEntitlementStatus(db, other)).dailyUsed).toBe(0);
      expect((await getEntitlementStatus(db, owner1)).dailyUsed).toBe(1);

      // Worker cozdu.
      await owner(
        "UPDATE link_resolution_request SET status = 'resolved', finished_at = now() WHERE id = $1",
        [first.requestId],
      );
      expect(await reconcileLinkRequestCharge(db, first.requestId)).toBe("settled");
      expect(await reconcileLinkRequestCharge(db, first.requestId)).toBeNull();
    });

    it("failed sonuc hakki iade eder", async () => {
      const user = await newUser();
      const result = await runChargedLinkSearch(db, {
        userId: user,
        sessionId: tag,
        requestKey: randomUUID(),
        urlRaw: url(2),
      });
      if (result.status !== "queued") throw new Error(result.status);
      pushedRequestIds.push(result.requestId);
      await owner(
        "UPDATE link_resolution_request SET status = 'failed', error_code = 'no_product', finished_at = now() WHERE id = $1",
        [result.requestId],
      );
      expect(await reconcileLinkRequestCharge(db, result.requestId)).toBe("refunded");
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(0);
    });

    it("ayni denemenin ikinci gonderimi ayni istegi dondurur, ikinci hak yok", async () => {
      const user = await newUser();
      const requestKey = randomUUID();
      const a = await runChargedLinkSearch(db, {
        userId: user,
        sessionId: tag,
        requestKey,
        urlRaw: url(3),
      });
      const b = await runChargedLinkSearch(db, {
        userId: user,
        sessionId: tag,
        requestKey,
        urlRaw: url(3),
      });
      if (a.status !== "queued" || b.status !== "queued") throw new Error("queued bekleniyordu");
      pushedRequestIds.push(a.requestId);
      expect(b.requestId).toBe(a.requestId);
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(1);
    });

    it("suren link aramasi varken baska yeni link busy doner", async () => {
      const user = await newUser();
      const a = await runChargedLinkSearch(db, {
        userId: user,
        sessionId: tag,
        requestKey: randomUUID(),
        urlRaw: url(4),
      });
      if (a.status !== "queued") throw new Error(a.status);
      pushedRequestIds.push(a.requestId);
      const b = await runChargedLinkSearch(db, {
        userId: user,
        sessionId: tag,
        requestKey: randomUUID(),
        urlRaw: url(5),
      });
      expect(b.status).toBe("busy");
      const charge = await owner<{ id: string }>(
        "SELECT id FROM ai_search_charge WHERE user_id = $1",
        [user],
      );
      expect(charge).toHaveLength(1);
      expect((await getCharge(db, charge[0]?.id as string))?.state).toBe("reserved");
    });
  });
});
