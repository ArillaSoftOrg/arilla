import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEMINI_INTERACTIONS_URL, GEMINI_MODEL } from "./gemini.ts";
import { formatSmokeReport, runGeminiSmoke, SMOKE_QUERY } from "./smoke.ts";

const KEY = "smoke-test-key-SECRET-0123456789";
const OPT_IN = { GEMINI_SMOKE: "1", GEMINI_API_KEY: KEY };

function reply(output: unknown, status = "completed") {
  return new Response(
    JSON.stringify({
      status,
      usage: {
        total_input_tokens: 900,
        total_output_tokens: 30,
        total_thought_tokens: 0,
        total_tokens: 930,
      },
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(output) }] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; body: string; key: string | null }[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: String(init?.body),
      key: new Headers(init?.headers).get("x-goog-api-key"),
    });
    return response();
  }) as typeof fetch;
  return { impl, calls };
}

const HELMET = {
  domain_id: "helmet",
  facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
  budget: null,
  price_preference: null,
};

describe("acik onay ve reddetme", () => {
  it.each([
    [{}, "missing_opt_in"],
    [{ GEMINI_API_KEY: KEY }, "missing_opt_in"],
    [{ GEMINI_SMOKE: "true", GEMINI_API_KEY: KEY }, "missing_opt_in"],
    [{ GEMINI_SMOKE: "1" }, "missing_api_key"],
    [{ ...OPT_IN, VERCEL_ENV: "production" }, "production_not_allowed"],
    [{ ...OPT_IN, NODE_ENV: "production" }, "production_not_allowed"],
  ] as const)("%j -> %s, istek gonderilmez", async (env, reason) => {
    const { impl, calls } = recordingFetch(() => reply(HELMET));
    expect(await runGeminiSmoke(env, { fetch: impl })).toEqual({ result: "refused", reason });
    expect(calls).toHaveLength(0);
  });

  it("disaridan metin kabul edilmez: argumanla calisma reddedilir", async () => {
    const { impl, calls } = recordingFetch(() => reply(HELMET));
    const report = await runGeminiSmoke(OPT_IN, { args: ["kullanici sorgusu"], fetch: impl });
    expect(report).toEqual({ result: "refused", reason: "unexpected_arguments" });
    expect(calls).toHaveLength(0);
  });

  it("uretimde ayri onayla calisir", async () => {
    const { impl, calls } = recordingFetch(() => reply(HELMET));
    const report = await runGeminiSmoke(
      { ...OPT_IN, VERCEL_ENV: "production", GEMINI_SMOKE_ALLOW_PRODUCTION: "1" },
      { fetch: impl },
    );
    expect(report.result).toBe("pass");
    expect(calls).toHaveLength(1);
  });
});

describe("istek", () => {
  it("yalnizca sabit sentetik sorgu, gercek uc nokta/model, store:false, tek deneme", async () => {
    const { impl, calls } = recordingFetch(() => reply(HELMET));
    await runGeminiSmoke(OPT_IN, { fetch: impl });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(GEMINI_INTERACTIONS_URL);
    expect(call?.key).toBe(KEY);
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.model).toBe(GEMINI_MODEL);
    expect(body.store).toBe(false);
    expect(body.generation_config.thinking_level).toBe("minimal");
    expect(JSON.parse(body.input).query).toBe(SMOKE_QUERY);
    expect(call?.body).not.toContain(KEY);
  });

  it("basarisiz denemede yeniden deneme yok (tek HTTP)", async () => {
    const { impl, calls } = recordingFetch(() => new Response("{}", { status: 503 }));
    const report = await runGeminiSmoke(OPT_IN, { fetch: impl });
    expect(calls).toHaveLength(1);
    expect(report).toMatchObject({ result: "fail", api: "failure", providerCode: "server_error" });
  });
});

describe("rapor", () => {
  it("kabul: durum ve sayilar; anahtar, istem, sorgu ve yorum icerigi yok", async () => {
    const { impl } = recordingFetch(() => reply(HELMET));
    const report = await runGeminiSmoke(OPT_IN, { fetch: impl });
    expect(report).toMatchObject({
      result: "pass",
      httpAttempts: 1,
      httpStatus: 200,
      api: "success",
      model: GEMINI_MODEL,
      validation: "accepted",
      totalTokens: 930,
    });
    const text = formatSmokeReport(report).join("\n");
    for (const forbidden of [KEY, SMOKE_QUERY, "helmet", "full_face", "Türkçe alışveriş"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("result: PASS");
  });

  it("kesik yanit gecersiz sayilir ve basarisizdir", async () => {
    const { impl } = recordingFetch(() => reply(HELMET, "incomplete"));
    const report = await runGeminiSmoke(OPT_IN, { fetch: impl });
    expect(report).toMatchObject({
      result: "fail",
      validation: "invalid",
      rejectedCodes: ["incomplete"],
    });
  });
});

describe("yalitim", () => {
  it("duman modulu veritabani ya da toplu is modullerini yuklemez", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "smoke.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      [
        "../clarification/interpreter.ts",
        "../clarification/rules.ts",
        "../clarification/state.ts",
        "./gemini.ts",
        "./intent-interpreter.ts",
      ].sort(),
    );
    for (const path of imports) {
      expect(path).not.toMatch(/@arilla\/db|pg|drizzle|query-interpretation|stored-interpretation/);
    }
  });
});
