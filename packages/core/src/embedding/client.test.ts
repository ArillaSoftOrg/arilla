import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmbeddingError,
  EmbeddingUnavailableError,
  FakeEmbeddingClient,
  getEmbeddingClient,
  JinaEmbeddingClient,
} from "./client.ts";

describe("getEmbeddingClient", () => {
  it("uses Jina when the API key is present", () => {
    const client = getEmbeddingClient({ JINA_API_KEY: "test-key", NODE_ENV: "production" });
    expect(client).toBeInstanceOf(JinaEmbeddingClient);
    expect(client.modelVersion).toBe("jina-clip-v2");
  });

  it("prefers the real key over the fake flag outside production", () => {
    const client = getEmbeddingClient({
      JINA_API_KEY: "test-key",
      EMBEDDING_FAKE_CLIENT: "true",
      NODE_ENV: "development",
    });
    expect(client).toBeInstanceOf(JinaEmbeddingClient);
  });

  it("uses the fake client only when explicitly requested outside production", () => {
    for (const nodeEnv of ["development", "test", undefined]) {
      const client = getEmbeddingClient({ EMBEDDING_FAKE_CLIENT: "true", NODE_ENV: nodeEnv });
      expect(client).toBeInstanceOf(FakeEmbeddingClient);
      expect(client.modelVersion).toBe("jina-clip-v2-fake");
    }
  });

  it("throws when the key is missing and no fake flag is set", () => {
    for (const env of [
      {},
      { NODE_ENV: "development" },
      { NODE_ENV: "production" },
      { JINA_API_KEY: "", NODE_ENV: "development" },
      { JINA_API_KEY: "   ", NODE_ENV: "development" },
      { EMBEDDING_FAKE_CLIENT: "false", NODE_ENV: "development" },
      { EMBEDDING_FAKE_CLIENT: "1", NODE_ENV: "development" },
    ]) {
      expect(() => getEmbeddingClient(env)).toThrow(EmbeddingUnavailableError);
    }
    try {
      getEmbeddingClient({});
    } catch (error) {
      expect((error as EmbeddingUnavailableError).reason).toBe("missing_api_key");
    }
  });

  it("refuses the fake flag in production, even with a key", () => {
    for (const env of [
      { EMBEDDING_FAKE_CLIENT: "true", NODE_ENV: "production" },
      { EMBEDDING_FAKE_CLIENT: "true", NODE_ENV: "production", JINA_API_KEY: "test-key" },
    ]) {
      let caught: unknown;
      try {
        getEmbeddingClient(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EmbeddingUnavailableError);
      expect((caught as EmbeddingUnavailableError).reason).toBe("fake_client_in_production");
    }
  });

  it("never puts the key value into the error message", () => {
    expect(() =>
      getEmbeddingClient({
        JINA_API_KEY: "secret-value",
        EMBEDDING_FAKE_CLIENT: "true",
        NODE_ENV: "production",
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("secret-value") }));
  });
});

describe("FakeEmbeddingClient", () => {
  it("is deterministic and unit-normalised", async () => {
    const client = new FakeEmbeddingClient();
    const a = await client.embedImage("data:image/png;base64,AAAA");
    const b = await client.embedImage("data:image/png;base64,AAAA");
    expect(a.vector).toEqual(b.vector);
    expect(a.vector).toHaveLength(768);
    const norm = Math.sqrt(a.vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe("JinaEmbeddingClient retry and timeout", () => {
  const DATA_URL = "data:image/png;base64,AAAA";

  function okResponse(): Response {
    return new Response(
      JSON.stringify({
        data: [{ embedding: Array.from({ length: 768 }, () => 0.01) }],
        usage: { total_tokens: 4000 },
      }),
      { status: 200 },
    );
  }

  /** Sinyal iptal edilene kadar asili kalan istek - yavas saglayici. */
  function hangingFetch(calls: { count: number }): typeof fetch {
    return ((_url: unknown, init?: RequestInit) => {
      calls.count++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
  }

  it("passes an abort signal to every attempt", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const client = new JinaEmbeddingClient("test-key", {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        return okResponse();
      }) as typeof fetch,
    });
    const result = await client.embedImage(DATA_URL);
    expect(result.vector).toHaveLength(768);
    expect(result.tokens).toBe(4000);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("retries a timed-out attempt and succeeds on the next one", async () => {
    let count = 0;
    const sleeps: number[] = [];
    const client = new JinaEmbeddingClient("test-key", {
      attemptTimeoutMs: 20,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: ((_url: unknown, init?: RequestInit) => {
        count++;
        if (count === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        }
        return Promise.resolve(okResponse());
      }) as typeof fetch,
    });
    const result = await client.embedImage(DATA_URL);
    expect(result.vector).toHaveLength(768);
    expect(count).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("fails closed with EmbeddingError when every attempt times out", async () => {
    const calls = { count: 0 };
    const client = new JinaEmbeddingClient("test-key", {
      attemptTimeoutMs: 10,
      sleep: async () => {},
      fetch: hangingFetch(calls),
    });
    const error = await client.embedImage(DATA_URL).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toMatch(/zaman aşımı/);
    expect(calls.count).toBe(4);
  });

  it("stops retrying when the backoff would exceed the total budget", async () => {
    let clock = 0;
    const calls = { count: 0 };
    const client = new JinaEmbeddingClient("test-key", {
      totalTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: (async () => {
        calls.count++;
        return new Response("busy", { status: 503 });
      }) as typeof fetch,
    });
    // 1. deneme -> 1 sn bekle -> 2. deneme -> 2 sn bekleme butceyi (2,5 sn) asar.
    await expect(client.embedImage(DATA_URL)).rejects.toThrow(/503/);
    expect(calls.count).toBe(2);
  });

  it("retries 429/5xx up to the attempt limit, then throws", async () => {
    const calls = { count: 0 };
    const client = new JinaEmbeddingClient("test-key", {
      sleep: async () => {},
      fetch: (async () => {
        calls.count++;
        return new Response("rate limited", { status: 429 });
      }) as typeof fetch,
    });
    await expect(client.embedImage(DATA_URL)).rejects.toThrow(EmbeddingError);
    expect(calls.count).toBe(4);
  });

  it("does not retry other 4xx responses", async () => {
    const calls = { count: 0 };
    const client = new JinaEmbeddingClient("test-key", {
      sleep: async () => {},
      fetch: (async () => {
        calls.count++;
        return new Response("bad key", { status: 401 });
      }) as typeof fetch,
    });
    await expect(client.embedImage(DATA_URL)).rejects.toThrow(/401/);
    expect(calls.count).toBe(1);
  });

  it("times out a stalled response body and retries", async () => {
    let count = 0;
    const client = new JinaEmbeddingClient("test-key", {
      attemptTimeoutMs: 20,
      sleep: async () => {},
      fetch: ((_url: unknown, init?: RequestInit) => {
        count++;
        if (count === 1) {
          // Basliklar geldi, govde gelmiyor: okuma ayni sinyalle kesilmeli.
          const stalled = {
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
              }),
          } as unknown as Response;
          return Promise.resolve(stalled);
        }
        return Promise.resolve(okResponse());
      }) as typeof fetch,
    });
    const result = await client.embedImage(DATA_URL);
    expect(result.vector).toHaveLength(768);
    expect(count).toBe(2);
  });

  describe("timer cleanup", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("leaves no pending timer after a successful attempt", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const client = new JinaEmbeddingClient("test-key", {
        fetch: (async () => okResponse()) as typeof fetch,
      });
      await client.embedImage(DATA_URL);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no pending timer after a non-retried 4xx", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const client = new JinaEmbeddingClient("test-key", {
        fetch: (async () => new Response("bad key", { status: 401 })) as typeof fetch,
      });
      await expect(client.embedImage(DATA_URL)).rejects.toThrow(/401/);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("never puts the API key into the final error", async () => {
    const client = new JinaEmbeddingClient("secret-value", {
      attemptTimeoutMs: 10,
      sleep: async () => {},
      fetch: hangingFetch({ count: 0 }),
    });
    await expect(client.embedImage(DATA_URL)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-value") }),
    );
  });
});
