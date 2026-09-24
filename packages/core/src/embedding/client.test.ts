import { describe, expect, it } from "vitest";
import {
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
