/**
 * `/ara` anlik IntentV2 (karar 0171 Faz 2) - gercek Postgres, sahte istemci.
 * Kosuya ozel sahte model surumu: satirlar gercek onbellekle karismaz; temizlik
 * yalnizca bu surumun satirlarini siler. Baglanti `test-db.ts` ile yalnizca
 * yerel (izole) veritabanina izinlidir.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { LlmCallOptions, LlmClient, LlmJsonRequest } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import type { ProviderBudgetHooks } from "../quota/provider-budget.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { applyIntentV2, intentV2Mode, resolveIntentV2 } from "./intent-v2-realtime.ts";
import type { LexiconEntry } from "./lexicon.ts";
import { normalizeQueryText } from "./normalize.ts";
import { REALTIME_INTERPRETATION_OPERATION } from "./realtime-interpretation.ts";
import type { QueryObject } from "./types.ts";

const TAG = Array.from({ length: 8 }, () =>
  String.fromCharCode(97 + Math.floor(Math.random() * 26)),
).join("");
const MODEL = `fake-iv2-${TAG}`;
const USAGE = { inputTokens: 500, outputTokens: 100, thoughtTokens: 0, totalTokens: 600 };
const LEXICON: LexiconEntry[] = [
  { kind: "brand", surface: "xiaomi", normalized: "xiaomi", weight: 1 },
];

type Reply = { kind: "value"; value: unknown } | { kind: "error"; error: LlmError };

function fakeClient(reply: () => Reply) {
  const calls: string[] = [];
  const client: LlmClient = {
    modelVersion: MODEL,
    async generateJson(request: LlmJsonRequest, options?: LlmCallOptions) {
      calls.push((JSON.parse(request.input) as { query: string }).query);
      const r = reply();
      if (r.kind === "error") {
        options?.onCall?.({ modelVersion: MODEL, httpStatus: 503, usage: null });
        throw r.error;
      }
      options?.onCall?.({ modelVersion: MODEL, httpStatus: 200, usage: USAGE });
      return { value: r.value, usage: USAGE, modelVersion: MODEL };
    },
  };
  return { client, calls };
}

const openBudget: ProviderBudgetHooks = {
  reserve: async (input) => ({
    allowed: true,
    reservation: { operation: input.operation, key: "k", ttlSeconds: 1, reserved: input.amount },
  }),
  settle: async () => undefined,
};
const noFlight = { acquire: async () => true, release: async () => undefined };
const base = { budget: openBudget, singleFlight: noFlight, lexicon: LEXICON };

/** Uzun + olumsuzluk: yonlendirme modeli cagirir. Yalniz harfli (gizlilik suzgeci). */
const q = (name: string) => `${name} ${TAG} xiaomi hariç uzun kayışlı akıllı saat`;

function excludedBrandReply(query: string) {
  return {
    schema_version: 2,
    product_type: { text: "akıllı saat", type_id: null, evidence: "akıllı saat" },
    role: "main",
    compatible_with: null,
    brand: null,
    excluded_brands: [{ text: "Xiaomi", evidence: "xiaomi hariç" }],
    attributes: [],
    budget: null,
    price_preference: null,
    use_case: null,
    ambiguous_fields: [],
    clarification: null,
    _q: query.length,
  };
}

function parsedOf(): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: "x",
    filters: {},
    style_tags: [],
    sort: "balanced",
    unparsed: "x",
    confidence: 0.5,
  };
}

async function rows(queryNorm: string) {
  return withOwnerClient(async (c) => {
    const qi = await c.query(
      "SELECT status, interpretation FROM query_interpretation WHERE model_version = $1 AND query_norm = $2",
      [MODEL, queryNorm],
    );
    const usage = await c.query(
      "SELECT operation FROM api_usage WHERE model_version = $1 ORDER BY id",
      [MODEL],
    );
    return { qi: qi.rows, usage: usage.rows.map((r) => r.operation as string) };
  });
}

afterAll(async () => {
  await withOwnerClient(async (c) => {
    await c.query("DELETE FROM query_interpretation WHERE model_version = $1", [MODEL]);
    await c.query("DELETE FROM api_usage WHERE model_version = $1", [MODEL]);
    await c
      .query("DELETE FROM ai_error_event WHERE model_version = $1", [MODEL])
      .catch(() => undefined);
  });
});

describe("intentV2Mode: 0062 on kosulu", () => {
  const key = { GEMINI_API_KEY: "k" };
  it.each([
    [{ ...key, GEMINI_REALTIME_ENABLED: "true", QUERY_INTENT_V2: "on" }, "on"],
    [{ ...key, GEMINI_REALTIME_ENABLED: "true", QUERY_INTENT_V2: "shadow" }, "shadow"],
    [{ ...key, GEMINI_REALTIME_ENABLED: "true", QUERY_INTENT_V2: "yes" }, "off"],
    [{ ...key, GEMINI_REALTIME_ENABLED: "false", QUERY_INTENT_V2: "on" }, "off"],
    [{ GEMINI_REALTIME_ENABLED: "true", QUERY_INTENT_V2: "on" }, "off"],
  ] as const)("%o -> %s", (env, mode) => {
    expect(intentV2Mode(env)).toBe(mode);
  });

  it("kapali bayrakta model cagrilmaz, sorgu aynen doner", async () => {
    const parsed = parsedOf();
    const out = await applyIntentV2(getTestDb(), q("kapali"), parsed, { env: {} });
    expect(out).toEqual({ parsed, mode: "off", applied: false, source: "none", hardFilters: 0 });
  });
});

describe("resolveIntentV2 / applyIntentV2 (gercek Postgres)", () => {
  it("yonlendirilen sorgu: tek cagri, api_usage + ham cikti saklanir, H filtre bos alana eklenir", async () => {
    const text = q("ilk");
    const { client, calls } = fakeClient(() => ({
      kind: "value",
      value: excludedBrandReply(text),
    }));
    const out = await applyIntentV2(getTestDb(), text, parsedOf(), { ...base, client });
    expect(calls).toHaveLength(1);
    expect(out.source).toBe("realtime");
    expect(out.applied).toBe(true);
    expect(out.parsed.filters.brand_exclude).toEqual(["xiaomi"]);
    const stored = await rows(normalizeQueryText(text));
    expect(stored.qi).toHaveLength(1);
    expect(stored.qi[0].status).toBe("accepted");
    expect(stored.qi[0].interpretation.schema_version).toBe(2);
    expect(stored.usage).toContain(REALTIME_INTERPRETATION_OPERATION);

    // Ikinci istek: saklanan ham cikti yeniden dogrulanir; model cagrilmaz.
    const again = await applyIntentV2(getTestDb(), text, parsedOf(), { ...base, client });
    expect(calls).toHaveLength(1);
    expect(again.source).toBe("stored");
    expect(again.parsed.filters.brand_exclude).toEqual(["xiaomi"]);
  });

  it("deterministik filtre ezilmez", async () => {
    const text = q("ezme");
    const { client } = fakeClient(() => ({ kind: "value", value: excludedBrandReply(text) }));
    const parsed = { ...parsedOf(), filters: { brand_exclude: ["apple"], price_max: 1000 } };
    const out = await applyIntentV2(getTestDb(), text, parsed, { ...base, client });
    expect(out.parsed.filters.price_max).toBe(1000);
    expect(out.parsed.filters.brand_exclude).toEqual(["apple", "xiaomi"]);
  });

  it("tek kelimelik sorgu yerelde kalir: cagri yok, satir yok", async () => {
    const { client, calls } = fakeClient(() => ({ kind: "value", value: {} }));
    const out = await resolveIntentV2(getTestDb(), `${TAG}`, { ...base, client });
    expect(out).toMatchObject({ source: "none", skip: "route_local" });
    expect(calls).toHaveLength(0);
  });

  it("saglayici hatasi: api_usage yazilir, yorum satiri yazilmaz, arama aynen", async () => {
    const text = q("hata");
    const { client, calls } = fakeClient(() => ({
      kind: "error",
      error: new LlmError("server_error", 503),
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parsedOf();
    const out = await applyIntentV2(getTestDb(), text, parsed, { ...base, client });
    expect(out.parsed).toBe(parsed);
    expect(out.applied).toBe(false);
    expect(calls).toHaveLength(1);
    const stored = await rows(normalizeQueryText(text));
    expect(stored.qi).toHaveLength(0);
    // Sonraki istek yeniden dener (satir yok).
    await applyIntentV2(getTestDb(), text, parsed, { ...base, client });
    expect(calls).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("gecersiz cikti: invalid saklanir, model tekrar cagrilmaz, filtre yok", async () => {
    const text = q("gecersiz");
    const { client, calls } = fakeClient(() => ({ kind: "value", value: { schema_version: 1 } }));
    const first = await resolveIntentV2(getTestDb(), text, { ...base, client });
    expect(first).toMatchObject({ source: "none", skip: "invalid" });
    const second = await resolveIntentV2(getTestDb(), text, { ...base, client });
    expect(second).toMatchObject({ source: "none", skip: "already_interpreted" });
    expect(calls).toHaveLength(1);
    expect((await rows(normalizeQueryText(text))).qi[0].status).toBe("invalid");
  });

  it("gunluk tavan dolu: cagri yok", async () => {
    const { client, calls } = fakeClient(() => ({ kind: "value", value: {} }));
    const out = await resolveIntentV2(getTestDb(), q("tavan"), {
      ...base,
      client,
      budget: { reserve: async () => ({ allowed: false }) as never, settle: async () => undefined },
    });
    expect(out).toMatchObject({ source: "none", skip: "daily_cap" });
    expect(calls).toHaveLength(0);
  });

  it("kisi limiti dolu: cagri yok", async () => {
    const { client, calls } = fakeClient(() => ({ kind: "value", value: {} }));
    const out = await resolveIntentV2(getTestDb(), q("kisi"), {
      ...base,
      client,
      actor: { userId: 1, ip: null },
      consume: async () => ({ allowed: false }) as never,
    });
    expect(out).toMatchObject({ source: "none", skip: "actor_limited" });
    expect(calls).toHaveLength(0);
  });

  it("gizlilik suzgecine takilan sorgu modele gitmez", async () => {
    const { client, calls } = fakeClient(() => ({ kind: "value", value: {} }));
    const out = await resolveIntentV2(getTestDb(), "ali@ornek.com adresli kılıf", {
      ...base,
      client,
    });
    expect(out).toMatchObject({ source: "none", skip: "ineligible" });
    expect(calls).toHaveLength(0);
  });
});
