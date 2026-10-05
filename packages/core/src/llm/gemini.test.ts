import { describe, expect, it } from "vitest";
import { LlmError } from "./client.ts";
import {
  GEMINI_INTERACTIONS_URL,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_MODEL,
  GeminiClient,
  getLlmClient,
} from "./gemini.ts";

const API_KEY = "test-key-SECRET-0123456789";
const PROMPT = "gizli-sorgu-metni kask 2000 tl";
const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };

interface Call {
  url: string;
  init: RequestInit;
}

function completed(text: string, usage: Record<string, unknown> = {}): unknown {
  return {
    id: "v1_x",
    status: "completed",
    usage: {
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_thought_tokens: 2,
      total_tokens: 17,
      ...usage,
    },
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
    object: "interaction",
    model: GEMINI_MODEL,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Sirayla yanit veren sahte fetch; her cagriyi kaydeder. */
function fakeFetch(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("beklenmeyen ek cagri");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof GeminiClient>[1]> = {},
) {
  const sleeps: number[] = [];
  const instance = new GeminiClient(API_KEY, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...extra,
  });
  return { instance, sleeps };
}

const REQUEST = { systemInstruction: "Talimat", input: PROMPT, schema: SCHEMA };

async function caught(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error("hata bekleniyordu");
}

/** Hata hicbir bicimde anahtar, istem ya da govde tasimamali. */
function expectRedacted(error: LlmError, ...secrets: string[]) {
  const surfaces = [error.message, String(error), JSON.stringify(error), error.stack ?? ""];
  for (const secret of [API_KEY, PROMPT, ...secrets]) {
    for (const surface of surfaces) expect(surface).not.toContain(secret);
  }
  expect((error as { cause?: unknown }).cause).toBeUndefined();
}

describe("istek bicimi", () => {
  it("kararli v1 uc noktasina POST, sabit model, minimal dusunme, store:false, yapilandirilmis cikti", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(completed('{"a":"x"}'))]);
    await client(impl).instance.generateJson({ ...REQUEST, maxOutputTokens: 256 });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    // Sabitle degil, metinle: uc nokta sessizce v1beta'ya donerse test patlar.
    expect(call?.url).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    expect(GEMINI_INTERACTIONS_URL).toBe(call?.url);
    expect(call?.init.method).toBe("POST");
    const body = JSON.parse(String(call?.init.body));
    expect(body).toEqual({
      model: "gemini-3.1-flash-lite",
      system_instruction: "Talimat",
      input: PROMPT,
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
      generation_config: { max_output_tokens: 256, thinking_level: "minimal" },
      store: false,
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("temperature ya da baska ornekleme ayari gonderilmez", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(completed('{"a":"x"}'))]);
    await client(impl).instance.generateJson(REQUEST);
    const raw = String(calls[0]?.init.body);
    for (const field of ["temperature", "top_p", "top_k", "topP", "topK"]) {
      expect(raw).not.toContain(field);
    }
    const body = JSON.parse(raw);
    expect(Object.keys(body.generation_config).sort()).toEqual([
      "max_output_tokens",
      "thinking_level",
    ]);
    expect(body.generation_config.max_output_tokens).toBe(1024);
  });

  it("anahtar yalnizca x-goog-api-key basliginda; govde ve adreste yok", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(completed('{"a":"x"}'))]);
    await client(impl).instance.generateJson(REQUEST);

    const call = calls[0];
    const headers = new Headers(call?.init.headers);
    expect(headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(headers.get("authorization")).toBeNull();
    expect(String(call?.init.body)).not.toContain(API_KEY);
    expect(call?.url).not.toContain(API_KEY);
  });
});

describe("yanit", () => {
  it("JSON metni ayristirir, kullanimi ayri dondurur", async () => {
    const { impl } = fakeFetch([jsonResponse(completed('{"a":"x"}'))]);
    const result = await client(impl).instance.generateJson(REQUEST);
    expect(result.value).toEqual({ a: "x" });
    expect(result.modelVersion).toBe(GEMINI_MODEL);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      thoughtTokens: 2,
      totalTokens: 17,
    });
  });

  it("parcali metin birlestirilir", async () => {
    const payload = completed("");
    (payload as { steps: unknown[] }).steps = [
      { type: "thought", content: [{ type: "text", text: "dusunce" }] },
      {
        type: "model_output",
        content: [
          { type: "text", text: '{"a":' },
          { type: "text", text: '"y"}' },
        ],
      },
    ];
    const { impl } = fakeFetch([jsonResponse(payload)]);
    expect((await client(impl).instance.generateJson(REQUEST)).value).toEqual({ a: "y" });
  });

  it("eksik kullanim alanlari 0 sayilir", async () => {
    const payload = completed('{"a":"x"}');
    (payload as { usage?: unknown }).usage = { total_tokens: "cok", total_input_tokens: -3 };
    const { impl } = fakeFetch([jsonResponse(payload)]);
    const result = await client(impl).instance.generateJson(REQUEST);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      totalTokens: 0,
    });
  });

  it.each([
    [
      "govde JSON degil",
      new Response("<html>body-secret</html>", { status: 200 }),
      "malformed_response",
    ],
    ["steps yok", jsonResponse({ status: "completed" }), "malformed_response"],
    [
      "model_output yok",
      jsonResponse({ status: "completed", steps: [{ type: "thought" }] }),
      "malformed_response",
    ],
    ["bos metin", jsonResponse(completed("   ")), "malformed_response"],
    ["metin JSON degil", jsonResponse(completed("body-secret degil json")), "invalid_json"],
    ["nesne degil", jsonResponse(["body-secret"]), "malformed_response"],
  ] as const)("%s → %s, yeniden denenmez", async (_label, response, code) => {
    const { impl, calls } = fakeFetch([response]);
    const error = await caught(client(impl).instance.generateJson(REQUEST));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expectRedacted(error, "body-secret");
  });

  it.each(["incomplete", "failed", "cancelled", "in_progress", "requires_action"])(
    "v1 durumu %s → incomplete, yalnizca sabit durum degeri tasinir",
    async (status) => {
      const { impl, calls } = fakeFetch([
        jsonResponse({
          status,
          steps: [{ type: "model_output", content: [{ type: "text", text: "body-secret" }] }],
        }),
      ]);
      const error = await caught(client(impl).instance.generateJson(REQUEST));
      expect(error.code).toBe("incomplete");
      expect(error.detail).toBe(status);
      expect(calls).toHaveLength(1);
      expectRedacted(error, "body-secret");
    },
  );

  it("max_output_tokens'a takilan kesik yanit, metni gecerli JSON olsa bile reddedilir", async () => {
    // Kesik cikti tesadufen gecerli JSON olabilir; yalnizca `completed` kabul edilir.
    const truncated = completed('{"a":"x"}', { total_output_tokens: 1024 });
    (truncated as { status: string }).status = "incomplete";
    const { impl, calls } = fakeFetch([jsonResponse(truncated)]);
    const error = await caught(client(impl).instance.generateJson(REQUEST));
    expect(error.code).toBe("incomplete");
    expect(error.detail).toBe("incomplete");
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("durumu olmayan yanit kabul edilmez", async () => {
    const payload = completed('{"a":"x"}');
    delete (payload as { status?: string }).status;
    const { impl } = fakeFetch([jsonResponse(payload)]);
    const error = await caught(client(impl).instance.generateJson(REQUEST));
    expect(error.code).toBe("malformed_response");
  });

  it("bilinmeyen durum metni hataya yazilmaz", async () => {
    const { impl } = fakeFetch([jsonResponse({ status: "body-secret-durum" })]);
    const error = await caught(client(impl).instance.generateJson(REQUEST));
    expect(error.code).toBe("malformed_response");
    expect(error.detail).toBeNull();
    expectRedacted(error, "body-secret-durum");
  });
});

describe("yeniden deneme", () => {
  it.each([429, 500, 503])("%i sonra basari", async (status) => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ error: { message: "body-secret" } }, status),
      jsonResponse(completed('{"a":"x"}')),
    ]);
    const { instance, sleeps } = client(impl);
    expect((await instance.generateJson(REQUEST)).value).toEqual({ a: "x" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it("deneme siniri asilinca son hata, sinirli sayida cagri", async () => {
    const { impl, calls } = fakeFetch(
      Array.from({ length: GEMINI_MAX_ATTEMPTS }, () =>
        jsonResponse({ error: { message: "body-secret" } }, 503),
      ),
    );
    const { instance, sleeps } = client(impl);
    const error = await caught(instance.generateJson(REQUEST));
    expect(error.code).toBe("server_error");
    expect(error.httpStatus).toBe(503);
    expect(calls).toHaveLength(GEMINI_MAX_ATTEMPTS);
    expect(sleeps).toEqual([500, 1000]);
    expectRedacted(error, "body-secret");
  });

  it("Retry-After beklemeyi uzatir", async () => {
    const { impl } = fakeFetch([
      jsonResponse({}, 429, { "Retry-After": "3" }),
      jsonResponse(completed('{"a":"x"}')),
    ]);
    const { instance, sleeps } = client(impl);
    await instance.generateJson(REQUEST);
    expect(sleeps).toEqual([3000]);
  });

  it("Retry-After sure butcesini asiyorsa beklenmez", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({}, 429, { "Retry-After": "120" })]);
    const { instance, sleeps } = client(impl);
    const error = await caught(instance.generateJson(REQUEST));
    expect(error.code).toBe("rate_limited");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([
    [400, "client_error"],
    [404, "client_error"],
    [401, "auth"],
    [403, "auth"],
  ] as const)("%i yeniden denenmez → %s", async (status, code) => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ error: { message: `body-secret ${API_KEY}` } }, status),
    ]);
    const error = await caught(client(impl).instance.generateJson(REQUEST));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expectRedacted(error, "body-secret");
  });

  it("ag hatasi yeniden denenir; ham hata mesaji tasinmaz", async () => {
    const { impl, calls } = fakeFetch([
      new TypeError(`fetch failed body-secret ${API_KEY}`),
      jsonResponse(completed('{"a":"x"}')),
    ]);
    await client(impl).instance.generateJson(REQUEST);
    expect(calls).toHaveLength(2);

    const { impl: failing } = fakeFetch(
      Array.from(
        { length: GEMINI_MAX_ATTEMPTS },
        () => new TypeError(`fetch failed body-secret ${API_KEY}`),
      ),
    );
    const error = await caught(client(failing).instance.generateJson(REQUEST));
    expect(error.code).toBe("network");
    expectRedacted(error, "body-secret");
  });
});

describe("zaman asimi", () => {
  it("istek sinyali zaman asiminda iptal eder ve yeniden denenir", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const calls: RequestInit[] = [];
    const impl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(init ?? {});
      return hang(init ?? {});
    }) as typeof fetch;

    const { instance, sleeps } = client(impl, { timeoutMs: 20, maxAttempts: 2 });
    const error = await caught(instance.generateJson(REQUEST));
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expectRedacted(error);
  });
});

describe("getLlmClient", () => {
  it("anahtar yoksa ya da bossa missing_api_key; sahte istemciye dusmez", () => {
    for (const env of [{}, { GEMINI_API_KEY: "" }, { GEMINI_API_KEY: "   " }]) {
      expect(() => getLlmClient(env)).toThrow(LlmError);
      try {
        getLlmClient(env);
      } catch (error) {
        expect((error as LlmError).code).toBe("missing_api_key");
      }
    }
  });

  it("anahtar sunucu ortamindan; model ortamdan degistirilemez", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(completed('{"a":"x"}'))]);
    const llm = getLlmClient(
      {
        GEMINI_API_KEY: ` ${API_KEY} `,
        GEMINI_MODEL: "baska-model",
        NEXT_PUBLIC_GEMINI_API_KEY: "x",
      },
      { fetch: impl },
    );
    expect(llm.modelVersion).toBe(GEMINI_MODEL);
    await llm.generateJson(REQUEST);
    expect(new Headers(calls[0]?.init.headers).get("x-goog-api-key")).toBe(API_KEY);
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe(GEMINI_MODEL);
  });
});
