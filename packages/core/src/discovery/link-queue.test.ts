/**
 * Link çözümleme kuyruğu taşıma katmanı (karar 0107): arka uç seçimi, mesaj
 * içeriği, idempotans anahtarı ve hata sınıflandırması. Ağ ve Redis yok.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isRedisUnavailableError } from "../redis/client.ts";
import {
  LINK_MESSAGE_RETENTION_SECONDS,
  LINK_RESOLUTION_QUEUE_KEY,
  LINK_RESOLUTION_TOPIC,
  LinkQueueUnavailableError,
  linkQueueBackend,
  publishLinkResolution,
} from "./link-queue.ts";

const ID = "0b6d5e3e-7a5b-4c58-9d5e-3f2a1c9e8d11";

describe("linkQueueBackend", () => {
  it("varsayılan redis'tir (bayrak yoksa davranış değişmez)", () => {
    expect(linkQueueBackend({})).toBe("redis");
    expect(linkQueueBackend({ LINK_QUEUE_BACKEND: "" })).toBe("redis");
  });

  it("yalnızca tam olarak 'vercel' Vercel Queues'u seçer", () => {
    expect(linkQueueBackend({ LINK_QUEUE_BACKEND: "vercel" })).toBe("vercel");
    expect(linkQueueBackend({ LINK_QUEUE_BACKEND: " Vercel " })).toBe("vercel");
    expect(linkQueueBackend({ LINK_QUEUE_BACKEND: "true" })).toBe("redis");
    expect(linkQueueBackend({ LINK_QUEUE_BACKEND: "vercel-queues" })).toBe("redis");
    expect(linkQueueBackend({ LINK_QUEUE_BACKEND: "kafka" })).toBe("redis");
  });
});

describe("publishLinkResolution", () => {
  it("redis: listeye yalnızca request_id bırakır", async () => {
    const redisPush = vi.fn().mockResolvedValue(1);
    const sendMessage = vi.fn();
    const backend = await publishLinkResolution(ID, { backend: "redis", redisPush, sendMessage });
    expect(backend).toBe("redis");
    expect(redisPush).toHaveBeenCalledWith(LINK_RESOLUTION_QUEUE_KEY, `{"request_id":"${ID}"}`);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("vercel: topic'e yalnızca request_id, idempotans anahtarı ve saklama süresiyle gönderir", async () => {
    const redisPush = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ messageId: "m1" });
    const backend = await publishLinkResolution(ID, { backend: "vercel", redisPush, sendMessage });
    expect(backend).toBe("vercel");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      LINK_RESOLUTION_TOPIC,
      { request_id: ID },
      { idempotencyKey: ID, retentionSeconds: LINK_MESSAGE_RETENTION_SECONDS },
    );
    expect(redisPush).not.toHaveBeenCalled();
  });

  it("redis: varsayılan itici LINK_REDIS_URL istemcisine yazar, genel istemciye değil", async () => {
    vi.resetModules();
    const lpush = vi.fn().mockResolvedValue(1);
    const generalLpush = vi.fn().mockResolvedValue(1);
    vi.doMock("../redis/client.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../redis/client.ts")>()),
      getLinkRedis: () => ({ lpush }),
      getRedis: () => ({ lpush: generalLpush }),
    }));
    try {
      const { publishLinkResolution: publish } = await import("./link-queue.ts");
      await publish(ID, { backend: "redis" });
      expect(lpush).toHaveBeenCalledWith(LINK_RESOLUTION_QUEUE_KEY, `{"request_id":"${ID}"}`);
      expect(generalLpush).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../redis/client.ts");
      vi.resetModules();
    }
  });

  it("Python worker ile kuyruk sözleşmesi: aynı anahtar, aynı topic, yük yalnızca request_id", () => {
    const worker = readFileSync(
      new URL("../../../../services/ingest/collect/link/worker.py", import.meta.url),
      "utf8",
    );
    const handler = readFileSync(
      new URL("../../../../services/ingest/collect/link/queue_handler.py", import.meta.url),
      "utf8",
    );
    expect(worker).toContain(`QUEUE_KEY = "${LINK_RESOLUTION_QUEUE_KEY}"`);
    expect(handler).toContain(`LINK_TOPIC = "${LINK_RESOLUTION_TOPIC}"`);
    expect(worker).toContain('payload["request_id"]');
  });

  it("topic adı ve saklama süresi Python tarafıyla ve 2 dk'lık bekleme penceresiyle uyumlu", () => {
    expect(LINK_RESOLUTION_TOPIC).toBe("link-resolution");
    expect(LINK_MESSAGE_RETENTION_SECONDS).toBeGreaterThanOrEqual(2 * 60);
  });

  for (const backend of ["redis", "vercel"] as const) {
    it(`${backend}: gönderim hatası mevcut çağıranların tanıdığı geçici kuyruk hatasına çevrilir`, async () => {
      const cause = new Error("ağ");
      const failing = vi.fn().mockRejectedValue(cause);
      const error = await publishLinkResolution(ID, {
        backend,
        redisPush: failing,
        sendMessage: failing,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LinkQueueUnavailableError);
      // charged-search, link-turn ve chat/service `isRedisUnavailableError` ile ayırır.
      expect(isRedisUnavailableError(error)).toBe(true);
      expect((error as LinkQueueUnavailableError).cause).toBe(cause);
      expect((error as Error).message).toContain(backend);
    });
  }

  it("hata mesajı kimlik/URL sızdırmaz", async () => {
    const error = await publishLinkResolution(ID, {
      backend: "vercel",
      sendMessage: vi.fn().mockRejectedValue(new Error("token=gizli")),
    }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("gizli");
    expect((error as Error).message).not.toContain(ID);
  });
});
