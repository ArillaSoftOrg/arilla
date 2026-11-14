import { describe, expect, it } from "vitest";
import type { QueryEmbedFailure } from "./query-embedder.ts";
import {
  acceptVector,
  createRemoteQueryEmbedder,
  endpointProblem,
  isPrivateHost,
  probeServiceHealth,
} from "./remote-query-embedder.ts";

const MODEL = "bge-m3-5617a9f6";
const SERVED = "BAAI/bge-m3";
const DIM = 8;

function unit(seed = 1): number[] {
  const raw = Array.from({ length: DIM }, (_, i) => Math.sin(seed + i) + 0.1);
  const n = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / n);
}

const ok = (vector: number[], model = SERVED, tokens = 7) =>
  new Response(
    JSON.stringify({ model, data: [{ embedding: vector }], usage: { total_tokens: tokens } }),
    { status: 200 },
  );

function embedder(
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createRemoteQueryEmbedder>[3]> = {},
  endpoint: { baseUrl?: string; token?: string } = {},
) {
  return createRemoteQueryEmbedder(
    {
      baseUrl: endpoint.baseUrl ?? "http://embed-query:8080",
      servedModel: SERVED,
      ...(endpoint.token ? { token: endpoint.token } : {}),
    },
    MODEL,
    DIM,
    { fetch: fetchImpl, cache: new Map(), ...extra },
  );
}

describe("adres kurallari", () => {
  it.each([
    ["http://embed-query:8080", null],
    ["http://localhost:18080", null],
    ["http://127.0.0.1:8080", null],
    ["http://10.1.2.3:8080", null],
    ["http://172.16.0.5", null],
    ["http://192.168.1.10:80/", null],
    ["https://embed.example.com", null],
    ["http://embed.example.com", "plain_http_public_host"],
    ["http://8.8.8.8", "plain_http_public_host"],
    ["http://172.32.0.1", "plain_http_public_host"],
    ["https://user:pw@embed.example.com", "credentials_in_url"],
    ["https://embed.example.com/?k=1", "query_or_fragment"],
    ["https://embed.example.com/#x", "query_or_fragment"],
    ["https://embed.example.com/v1", "path_not_root"],
    ["ftp://embed", "invalid_url"],
    ["not a url", "invalid_url"],
    ["", "empty"],
    [undefined, "empty"],
  ])("%s -> %s", (url, problem) => {
    expect(endpointProblem(url)).toBe(problem);
  });

  it("ozel ag ayrimi", () => {
    expect(isPrivateHost("embed-query")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("api.jina.ai")).toBe(false);
    expect(isPrivateHost("11.0.0.1")).toBe(false);
  });

  it("gecersiz adresle istemci KURULMAZ", () => {
    expect(() =>
      createRemoteQueryEmbedder(
        { baseUrl: "http://evil.example.com", servedModel: SERVED },
        MODEL,
        DIM,
      ),
    ).toThrow("gecersiz sorgu servisi adresi");
  });
});

describe("istek ve yanit", () => {
  it("OpenAI uyumlu govde, onek YOK, bosluk sadelesir, anahtar yalniz Authorization basliginda", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const e = embedder(
      (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return ok(unit());
      }) as typeof fetch,
      {},
      { token: "s3cret-token" },
    );
    const res = await e.embedQuery("  kablosuz   kulaklık  ");
    expect(res?.vector).toEqual(unit());
    expect(res?.cacheHit).toBe(false);
    const call = captured as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("http://embed-query:8080/v1/embeddings");
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: SERVED,
      input: ["kablosuz kulaklık"],
      encoding_format: "float",
    });
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret-token");
    expect(String(call.init.body)).not.toContain("s3cret-token");
  });

  it("anahtar yoksa Authorization basligi gonderilmez", async () => {
    let headers: Record<string, string> = {};
    const e = embedder((async (_u: unknown, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return ok(unit());
    }) as typeof fetch);
    await e.embedQuery("laptop");
    expect(headers.Authorization).toBeUndefined();
  });

  it("onbellek: ayni sorgu ikinci kez servise gitmez ve kullanim cacheHit olarak bildirilir", async () => {
    let calls = 0;
    const usage: { tokens: number; cacheHit: boolean }[] = [];
    const e = embedder(
      (async () => {
        calls += 1;
        return ok(unit(), SERVED, 9);
      }) as typeof fetch,
      { onUsage: (u) => void usage.push({ tokens: u.tokens, cacheHit: u.cacheHit }) },
    );
    const first = await e.embedQuery("Laptop");
    const second = await e.embedQuery("  laptop ");
    expect(calls).toBe(1);
    expect(second?.cacheHit).toBe(true);
    expect(second?.vector).toEqual(first?.vector);
    expect(usage).toEqual([
      { tokens: 9, cacheHit: false },
      { tokens: 0, cacheHit: true },
    ]);
  });

  it("bos sorgu servise gitmez", async () => {
    let calls = 0;
    const e = embedder((async () => {
      calls += 1;
      return ok(unit());
    }) as typeof fetch);
    expect(await e.embedQuery("   ")).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("vektor uzayi kapilari: yanlis vektor ASLA kullanilmaz", () => {
  const bad = (name: string, response: () => Response) =>
    it(name, async () => {
      const failures: QueryEmbedFailure[] = [];
      let successes = 0;
      const e = embedder((async () => response()) as typeof fetch, {
        onFailure: (f) => void failures.push(f),
        onSuccess: () => {
          successes += 1;
        },
      });
      expect(await e.embedQuery("laptop")).toBeNull();
      expect(failures).toEqual(["bad_payload"]);
      expect(successes).toBe(0);
    });

  bad("baska model adi", () => ok(unit(), "BAAI/bge-m3-other"));
  bad("yanlis boyut", () => ok(unit().slice(0, 4)));
  bad("sonlu olmayan deger", () => ok([...unit().slice(1), Number.NaN]));
  bad("norm ~1 degil (yanlis havuzlama/normalizasyon belirtisi)", () =>
    ok(unit().map((v) => v * 3)),
  );
  bad("govde JSON degil", () => new Response("<html>", { status: 200 }));
  bad("data yok", () => new Response(JSON.stringify({ model: SERVED }), { status: 200 }));

  it("acceptVector: norm toleransi icinde kabul, disinda red", () => {
    expect(
      acceptVector({ model: SERVED, data: [{ embedding: unit() }] }, SERVED, DIM),
    ).not.toBeNull();
    expect(
      acceptVector(
        { model: SERVED, data: [{ embedding: unit().map((v) => v * 1.5) }] },
        SERVED,
        DIM,
      ),
    ).toBeNull();
  });
});

describe("hata siniflandirma ve gizlilik", () => {
  it.each([
    [401, "auth"],
    [402, "quota"],
    [429, "rate_limited"],
    [503, "server"],
    [422, "client"],
  ] as const)("HTTP %s -> %s", async (status, failure) => {
    const failures: QueryEmbedFailure[] = [];
    const e = embedder(
      (async () => new Response("detail: sorgu metni", { status })) as typeof fetch,
      {
        onFailure: (f) => void failures.push(f),
      },
    );
    expect(await e.embedQuery("gizli sorgu")).toBeNull();
    expect(failures).toEqual([failure]);
  });

  it("ag hatasi ve zaman asimi firlatmaz; `network` / `timeout`", async () => {
    const failures: QueryEmbedFailure[] = [];
    const net = embedder(
      (async () => {
        throw new TypeError("fetch failed: http://embed-query:8080 token=abc");
      }) as typeof fetch,
      { onFailure: (f) => void failures.push(f) },
    );
    expect(await net.embedQuery("laptop")).toBeNull();
    const slow = embedder(
      ((_u: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
          );
        })) as typeof fetch,
      { timeoutMs: 20, onFailure: (f) => void failures.push(f) },
    );
    expect(await slow.embedQuery("laptop")).toBeNull();
    expect(failures).toEqual(["network", "timeout"]);
  });

  it("anahtar, adres ve sorgu metni konsola/uyariya SIZMAZ", async () => {
    const lines: string[] = [];
    const spies = ["log", "info", "warn", "error"].map((m) => {
      const original = (console as unknown as Record<string, unknown>)[m];
      (console as unknown as Record<string, unknown>)[m] = (...args: unknown[]) =>
        void lines.push(args.map(String).join(" "));
      return () => {
        (console as unknown as Record<string, unknown>)[m] = original;
      };
    });
    try {
      const e = embedder(
        (async () => {
          throw new Error("boom http://embed-query:8080 Bearer tok-123 secret query");
        }) as typeof fetch,
        {},
        { token: "tok-123" },
      );
      await e.embedQuery("secret query");
    } finally {
      for (const restore of spies) restore();
    }
    expect(lines.join("\n")).not.toMatch(/tok-123|embed-query|secret query/);
  });
});

describe("saglik sondasi", () => {
  it("200 -> saglikli; diger, ag hatasi ve gecersiz adres -> degil; govde/adres donmez", async () => {
    expect(
      await probeServiceHealth("http://embed-query:8080", {
        fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
      }),
    ).toBe(true);
    expect(
      await probeServiceHealth("http://embed-query:8080", {
        fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
      }),
    ).toBe(false);
    expect(
      await probeServiceHealth("http://embed-query:8080", {
        fetch: (async () => {
          throw new Error("down");
        }) as typeof fetch,
      }),
    ).toBe(false);
    expect(await probeServiceHealth("http://evil.example.com")).toBe(false);
  });
});
