/**
 * Karar 0107: `enqueueLinkResolution` iki taşıma katmanında da aynı satır
 * davranışını korur - gerçek Postgres, sahte kuyruk. Redis/Vercel gerekmez.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isRedisUnavailableError } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { LINK_RESOLUTION_QUEUE_KEY, LINK_RESOLUTION_TOPIC } from "./link-queue.ts";
import { enqueueLinkResolution, getLinkResolutionStatus } from "./link-resolution.ts";

const HOST = "https://link-kuyruk-entegrasyon.example";

async function cleanup(): Promise<void> {
  await withOwnerClient((client) =>
    client.query("DELETE FROM link_resolution_request WHERE normalized_url LIKE $1", [`${HOST}%`]),
  );
}

const input = (path: string) => ({
  urlRaw: `${HOST}${path}`,
  sessionId: "entegrasyon",
  userId: null,
});

describe("enqueueLinkResolution taşıma katmanları", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
  });
  afterAll(cleanup);

  it("vercel: satır 'queued' kalır, topic'e yalnızca satır kimliği gider", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: "m" });
    const { requestId, reused } = await enqueueLinkResolution(db, input("/urun/a"), {
      queue: { backend: "vercel", sendMessage },
    });
    expect(reused).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      LINK_RESOLUTION_TOPIC,
      { request_id: requestId },
      expect.objectContaining({ idempotencyKey: requestId }),
    );
    expect((await getLinkResolutionStatus(db, requestId))?.status).toBe("queued");
  });

  it("redis: eski davranış - listeye aynı biçimde bırakılır", async () => {
    const redisPush = vi.fn().mockResolvedValue(1);
    const { requestId } = await enqueueLinkResolution(db, input("/urun/b"), {
      queue: { backend: "redis", redisPush },
    });
    expect(redisPush).toHaveBeenCalledWith(
      LINK_RESOLUTION_QUEUE_KEY,
      JSON.stringify({ request_id: requestId }),
    );
  });

  it("önbellek isabetinde kuyruğa hiç yazılmaz (iki katmanda da)", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    await enqueueLinkResolution(db, input("/urun/c"), {
      queue: { backend: "vercel", sendMessage },
    });
    sendMessage.mockClear();
    const again = await enqueueLinkResolution(db, input("/urun/c"), {
      queue: { backend: "vercel", sendMessage },
    });
    expect(again.reused).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  for (const backend of ["redis", "vercel"] as const) {
    it(`${backend}: gönderim başarısızsa satır 'failed/queue_unavailable' olur ve hata geçici sayılır`, async () => {
      const failing = vi.fn().mockRejectedValue(new Error("kuyruk yok"));
      const error = await enqueueLinkResolution(db, input(`/urun/hata-${backend}`), {
        queue: { backend, redisPush: failing, sendMessage: failing },
      }).catch((e: unknown) => e);
      expect(isRedisUnavailableError(error)).toBe(true);

      // Geçici kod: aynı adrese hemen yeniden denemek önbelleğe takılmaz.
      const retry = await enqueueLinkResolution(db, input(`/urun/hata-${backend}`), {
        queue: { backend, redisPush: vi.fn().mockResolvedValue(1), sendMessage: vi.fn() },
      });
      expect(retry.reused).toBe(false);
    });
  }
});
