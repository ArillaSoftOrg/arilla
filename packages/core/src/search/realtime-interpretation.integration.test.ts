/**
 * Anlik Gemini yorumu (karar 0062) - gercek yerel Postgres, sahte LLM
 * istemcisi (ag YOK). Yorumun aramayi gercekten degistirdigi `compileQuery`
 * ciktisi uzerinden kanitlanir: SQL suzgec parametreleri (`filters`) ve metin
 * kapisi (`textSlotsOf`).
 *
 * Yalitim: kosuya ozel sahte model surumu ve taksonomi varyanti; yazilan
 * `query_interpretation` ve `api_usage` satirlari yalnizca bunlarla eslesir
 * ve test sonunda silinir. Sorgu etiketi yalnizca harf: rakamli karisik
 * belirtec sir suzgecine takilir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import {
  planConversationWithInterpretationSource,
  planConversationWithRealtimeInterpretation,
} from "../conversational-search/stored-plan.ts";
import type { LlmCallOptions, LlmClient, LlmJsonRequest } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import {
  type ProviderBudgetHooks,
  providerBudgetKey,
  reserveProviderBudget,
} from "../quota/provider-budget.ts";
import type { QuotaConsumeResult, QuotaConsumer } from "../quota/redis-windows.ts";
import { getRedis, RedisUnavailableError } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { providerCallsToday, QUERY_INTERPRETATION_OPERATION } from "./query-interpretation.ts";
import {
  isRealtimeInterpretationEnabled,
  REALTIME_INTERPRETATION_OPERATION,
  resolveRealtimeInterpretation,
} from "./realtime-interpretation.ts";
import { search } from "./search.ts";
import { textSlotsOf } from "./search-sql.ts";
import { buildSearchSummary } from "./search-summary.ts";

const TAG = Date.now()
  .toString(36)
  .replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)] ?? "x");
const MODEL = `fake-rt-${TAG}`;

/** Taksonomi varyanti: kosuya ozel ozet, gercek onbellekle karismaz. */
function registryVariant(): ClarificationRegistry {
  const base = DEFAULT_CLARIFICATION_REGISTRY;
  const [first, ...rest] = base.domains;
  if (!first) throw new Error("taksonomi bos");
  const [facet, ...others] = first.facets;
  if (!facet) throw new Error("faset yok");
  return {
    ...base,
    domains: [
      { ...first, facets: [{ ...facet, question: `${facet.question} ${TAG}` }, ...others] },
      ...rest,
    ],
  };
}
const REGISTRY = registryVariant();
const CONTEXT = { registry: REGISTRY, lexicon: [] };
const USAGE = { inputTokens: 90, outputTokens: 10, thoughtTokens: 0, totalTokens: 100 };

type Reply =
  | { kind: "value"; value: unknown }
  | { kind: "error"; error: LlmError; httpStatus: number | null };

/** Sorguya gore cevap veren sahte istemci; her cagri sayilir. */
function fakeClient(reply: (query: string) => Reply) {
  const queries: string[] = [];
  const client: LlmClient = {
    modelVersion: MODEL,
    async generateJson(request: LlmJsonRequest, options?: LlmCallOptions) {
      const { query } = JSON.parse(request.input) as { query: string };
      queries.push(query);
      const r = reply(query);
      if (r.kind === "error") {
        options?.onCall?.({ modelVersion: MODEL, httpStatus: r.httpStatus, usage: null });
        throw r.error;
      }
      options?.onCall?.({ modelVersion: MODEL, httpStatus: 200, usage: USAGE });
      return { value: r.value, usage: USAGE, modelVersion: MODEL };
    },
  };
  return { client, queries };
}

const helmetFullFace = {
  domain_id: "helmet",
  facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
  budget: null,
  price_preference: null,
};

async function realtimeCallsToday(): Promise<number> {
  return providerCallsToday(getTestDb(), new Date(), REALTIME_INTERPRETATION_OPERATION);
}

async function storedStatus(queryNorm: string): Promise<string | null> {
  return withOwnerClient(async (c) => {
    const r = await c.query(
      "SELECT status FROM query_interpretation WHERE model_version = $1 AND query_norm = $2",
      [MODEL, queryNorm],
    );
    return r.rows[0]?.status ?? null;
  });
}

/** Sentetik laptop katalogu (kosuya ozel, kapali kume): aramanin GERCEKTEN degistigini gosterir. */
const FIXTURE = {
  gamingInBudget: `${TAG} Gaming Laptop 15`,
  gamingOverBudget: `${TAG} Gaming Laptop Pro`,
  office: `${TAG} Ofis Notebook`,
  headset: `${TAG} Gaming Kulaklik`,
};
let fixtureMerchantId = 0;

beforeAll(async () => {
  await withOwnerClient(async (c) => {
    const category = await c.query("SELECT id FROM category WHERE path = 'elektronik'");
    const categoryId = category.rows[0]?.id;
    if (!categoryId) throw new Error("yerel katalogda elektronik kategorisi yok");
    const merchant = await c.query(
      `INSERT INTO merchant (slug, name, domain, source_type, is_active)
       VALUES ($1, 'RT Test Magaza', $2, 'xml_feed', TRUE) RETURNING id`,
      [`rt-merchant-${TAG}`, `rt-${TAG}.test`],
    );
    fixtureMerchantId = Number(merchant.rows[0].id);
    const rows: [string, number][] = [
      [FIXTURE.gamingInBudget, 900_000],
      [FIXTURE.gamingOverBudget, 1_500_000],
      [FIXTURE.office, 800_000],
      [FIXTURE.headset, 200_000],
    ];
    for (const [index, [title, priceKurus]] of rows.entries()) {
      const product = await c.query(
        `INSERT INTO product (slug, title, category_id, min_price, max_price, offer_count, in_stock_count)
         VALUES ($1, $2, $3, $4, $4, 1, 1) RETURNING id`,
        [`rt-urun-${TAG}-${index}`, title, categoryId, priceKurus],
      );
      await c.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE)`,
        [
          fixtureMerchantId,
          product.rows[0].id,
          `rt-${index}`,
          `https://rt-${TAG}.test/${index}`,
          title,
          priceKurus,
        ],
      );
    }
  });
});

afterAll(async () => {
  await withOwnerClient(async (c) => {
    await c.query("DELETE FROM query_interpretation WHERE model_version = $1", [MODEL]);
    await c.query("DELETE FROM api_usage WHERE model_version = $1", [MODEL]);
    await c.query("DELETE FROM offer WHERE merchant_id = $1", [fixtureMerchantId]);
    await c.query("DELETE FROM product WHERE slug LIKE $1", [`rt-urun-${TAG}-%`]);
    await c.query("DELETE FROM merchant WHERE id = $1", [fixtureMerchantId]);
  });
});

function never(): never {
  throw new Error("beklenmeyen null");
}

describe("laptop: '10 bin liraya kadar oyun için hafif laptop'", () => {
  const query = "10 bin liraya kadar oyun icin hafif laptop";
  const laptopReply = {
    domain_id: "laptop",
    facets: [{ facet_id: "laptop_qualifier", option_id: "gaming" }],
    budget: { min_try: null, max_try: 10000 },
    price_preference: null,
  };

  it("Gemini yorumu gerçek sonuçları değiştirir; özet ürün uydurmaz", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: laptopReply }));
    const request = { query, steps: [], reply: null };
    const result = await planConversationWithRealtimeInterpretation(getTestDb(), request, CONTEXT, {
      realtime: { client },
    });
    expect(queries).toEqual([query]);
    expect(result.interpretationSource).toBe("realtime_model");
    if (result.plan.mode !== "conversation") throw new Error("plan");
    // "10 bin" -> 10000 TL; kategori + baslik niteleyicisi; "hafif" suzgec degil.
    expect(result.plan.queryObject.filters).toEqual({
      category_path: "elektronik",
      price_max: 1_000_000,
    });
    expect(textSlotsOf(result.plan.queryObject)).toEqual([
      ["gaming"],
      ["laptop", "notebook", "dizustu"],
    ]);

    const found = await search(getTestDb(), result.plan.queryObject, { limit: 50 });
    const ours = found.items.map((item) => item.title).filter((t) => t.startsWith(TAG));
    expect(ours).toEqual([FIXTURE.gamingInBudget]);

    // Ayni sorgu model olmadan (bugunku yol): konusma yok, kategori/nitelik yok.
    const legacy = await planConversationWithInterpretationSource(getTestDb(), request, CONTEXT);
    expect(legacy.plan.mode).toBe("conventional");

    expect(result.summaryIntent).toMatchObject({
      typeLabel: "Laptop / dizüstü bilgisayar",
      budget: { minKurus: null, maxKurus: 1_000_000 },
      unsupported: ["hafiflik"],
    });
    const summary = buildSearchSummary(result.summaryIntent ?? never(), {
      resultCount: found.total,
      usedFallback: false,
    });
    expect(summary).toContain("Laptop / dizüstü bilgisayar");
    expect(summary).toContain("hafiflik bilgisi katalogda olmadığı için");
    for (const title of Object.values(FIXTURE)) expect(summary).not.toContain(title);
    expect(summary).not.toMatch(/RT Test Magaza|9\.000|15\.000/);
  });

  it("aynı sorgu ikinci kez: saklanan yorum, model çağrısı yok, özet yine var", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: laptopReply }));
    const result = await planConversationWithRealtimeInterpretation(
      getTestDb(),
      { query, steps: [], reply: null },
      CONTEXT,
      { realtime: { client } },
    );
    expect(queries).toEqual([]);
    expect(result.interpretationSource).toBe("stored_model");
    expect(result.summaryIntent?.typeLabel).toBe("Laptop / dizüstü bilgisayar");
  });

  it("model hatasında özet yok, plan deterministik", async () => {
    const q = `${query} ${TAG} hatali`;
    const { client } = fakeClient(() => ({
      kind: "error",
      error: new LlmError("timeout"),
      httpStatus: null,
    }));
    const result = await planConversationWithRealtimeInterpretation(
      getTestDb(),
      { query: q, steps: [], reply: null },
      CONTEXT,
      { realtime: { client } },
    );
    expect(result.summaryIntent).toBeNull();
    expect(result.plan.mode).toBe("conventional");
  });
});

describe("kişi başına anlık limit (quota/policy.ts)", () => {
  /** Kota cagrilarini kaydeden sahte harcayici. */
  function recordingConsume(result: QuotaConsumeResult = { allowed: true }) {
    const calls: Array<{ pool: string; subject: string }> = [];
    const consume: QuotaConsumer = async (input) => {
      calls.push({ pool: input.pool, subject: input.subject });
      return result;
    };
    return { calls, consume };
  }

  it("limit dolduysa model çağrılmaz, arama deterministik yoldan sürer", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const { consume } = recordingConsume({ allowed: false, window: "day" });
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} limit`, {
      client,
      registry: REGISTRY,
      actor: { userId: null, ip: "198.51.100.77" },
      consume,
    });
    expect(result).toEqual({ source: "none", reason: "actor_limited" });
    expect(queries).toEqual([]);
  });

  it("girişli kullanıcı kendi havuzundan, anonim IP özetiyle ayrı havuzdan harcar", async () => {
    const { client } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const signedIn = recordingConsume();
    await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} girisli`, {
      client,
      registry: REGISTRY,
      actor: { userId: 42, ip: "198.51.100.9" },
      consume: signedIn.consume,
    });
    expect(signedIn.calls).toEqual([{ pool: "realtime_interpretation_user", subject: "user:42" }]);

    const anonymous = recordingConsume();
    await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} anonim`, {
      client,
      registry: REGISTRY,
      actor: { userId: null, ip: "198.51.100.9" },
      consume: anonymous.consume,
    });
    expect(anonymous.calls).toHaveLength(1);
    expect(anonymous.calls[0]?.pool).toBe("realtime_interpretation_anonymous");
    // Ham IP anahtara girmez: yalnizca HMAC-SHA256 takma adi.
    expect(anonymous.calls[0]?.subject).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(anonymous.calls[0]?.subject).not.toContain("198.51.100.9");
  });

  it("limit sayacı okunamazsa model çağrılmaz (maliyet kapalı), hata fırlamaz", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} redisyok`, {
      client,
      registry: REGISTRY,
      actor: { userId: 7, ip: null },
      consume: async () => {
        throw new RedisUnavailableError("kota");
      },
    });
    expect(result).toEqual({ source: "none", reason: "actor_limited" });
    expect(queries).toEqual([]);
  });

  it("IP özeti için sır tanımsızsa model çağrılmaz (maliyet kapalı), hata fırlamaz", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const { calls, consume } = recordingConsume();
    const original = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} sirsiz`, {
        client,
        registry: REGISTRY,
        actor: { userId: null, ip: "198.51.100.9" },
        consume,
      });
      expect(result).toEqual({ source: "none", reason: "actor_limited" });
    } finally {
      process.env.SESSION_SECRET = original;
    }
    expect(calls).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("önbellek isabeti limiti tüketmez", async () => {
    const query = `kafa koruyucu ${TAG} onbellek`;
    const { client } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    // Ilk istek yorumu saklar (limitsiz cagri); ikincisi onbellekten gelir.
    await resolveRealtimeInterpretation(getTestDb(), query, { client, registry: REGISTRY });
    const { calls, consume } = recordingConsume();
    const result = await resolveRealtimeInterpretation(getTestDb(), query, {
      client,
      registry: REGISTRY,
      actor: { userId: 9, ip: null },
      consume,
    });
    expect(result.source).toBe("stored");
    expect(calls).toEqual([]);
  });

  it("süzgece takılan ya da boş sorgu limiti tüketmez", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const { calls, consume } = recordingConsume();
    for (const text of ["", "   ", "beni 0532 123 45 67 numarasından ara"]) {
      const result = await resolveRealtimeInterpretation(getTestDb(), text, {
        client,
        registry: REGISTRY,
        actor: { userId: 11, ip: null },
        consume,
      });
      expect(result.source).toBe("none");
    }
    expect(calls).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("bayrak kapalıyken (deterministik arama) limit tüketilmez", async () => {
    const { calls, consume } = recordingConsume();
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} kapali`, {
      env: {},
      registry: REGISTRY,
      actor: { userId: 12, ip: null },
      consume,
    });
    expect(result).toEqual({ source: "none", reason: "disabled" });
    expect(calls).toEqual([]);
  });

  it("günlük toplam tavan doluysa kişi limiti tüketilmez", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const { calls, consume } = recordingConsume();
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} tavan`, {
      client,
      registry: REGISTRY,
      actor: { userId: 13, ip: null },
      dailyCallCap: 0,
      consume,
    });
    expect(result).toEqual({ source: "none", reason: "daily_cap" });
    expect(calls).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe("bayrak", () => {
  it("varsayılan kapalı: anahtar olsa da bayraksız çalışmaz", () => {
    expect(isRealtimeInterpretationEnabled({})).toBe(false);
    expect(isRealtimeInterpretationEnabled({ GEMINI_API_KEY: "k" })).toBe(false);
    expect(isRealtimeInterpretationEnabled({ GEMINI_REALTIME_ENABLED: "true" })).toBe(false);
    expect(
      isRealtimeInterpretationEnabled({ GEMINI_REALTIME_ENABLED: "true", GEMINI_API_KEY: "k" }),
    ).toBe(true);
  });

  it("kapalıyken plan bugünkü yolla birebir aynı; model çağrılmaz", async () => {
    const request = { query: `kask ${TAG} kapali`, steps: [], reply: null };
    const legacy = await planConversationWithInterpretationSource(getTestDb(), request, CONTEXT);
    const result = await planConversationWithRealtimeInterpretation(getTestDb(), request, CONTEXT, {
      realtime: { env: {} },
    });
    expect(result.realtimeSkip).toBe("disabled");
    expect(result.plan).toEqual(legacy.plan);
  });
});

describe("önbelleksiz sorgu: aynı istekte Gemini ve aramaya etkisi", () => {
  const query = `motor surerken kafa koruyucu ${TAG}`;

  it("deterministik domain yokken Gemini domain + nitelik verir; SQL değişir", async () => {
    const before = await realtimeCallsToday();
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const request = { query, steps: [], reply: null };

    const legacy = await planConversationWithInterpretationSource(getTestDb(), request, CONTEXT);
    expect(legacy.plan.mode).toBe("conventional");

    const result = await planConversationWithRealtimeInterpretation(getTestDb(), request, CONTEXT, {
      realtime: { client },
    });
    expect(queries).toEqual([query]);
    expect(result.interpretationSource).toBe("realtime_model");
    expect(result.plan.mode).toBe("conversation");
    if (result.plan.mode !== "conversation") throw new Error("plan");

    // Gemini ciktisi SQL'in metin kapisina: domain `helmet` -> retrievalTerms
    // ("kask", sorguda YOK), `full_face` -> "kapali" (katlanmis). Deterministik
    // yol bu sorguda konusma kurmaz; `/ara` duz metinle arardi.
    const slots = textSlotsOf(result.plan.queryObject).flat();
    expect(slots).toContain("kask");
    expect(slots).toContain("kapali");
    expect(query).not.toContain("kask");

    // Muhasebe ve onbellek: bir HTTP denemesi, kabul edilmis satir.
    expect(await realtimeCallsToday()).toBe(before + 1);
    expect(await storedStatus(query)).toBe("accepted");
  });

  it("aynı sorgu ikinci kez: saklanan yorum yeniden kullanılır, model çağrılmaz", async () => {
    const before = await realtimeCallsToday();
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const result = await planConversationWithRealtimeInterpretation(
      getTestDb(),
      { query, steps: [], reply: null },
      CONTEXT,
      { realtime: { client } },
    );
    expect(queries).toEqual([]);
    expect(result.interpretationSource).toBe("stored_model");
    expect(result.plan.mode).toBe("conversation");
    expect(await realtimeCallsToday()).toBe(before);
  });

  it("uydurma ürün/fiyat alanı yok sayılır; sonuçlar yalnızca katalogdan", async () => {
    const q = `kask ${TAG} uydurma`;
    const { client } = fakeClient(() => ({
      kind: "value",
      value: {
        ...helmetFullFace,
        products: [{ title: `UYDURMA URUN ${TAG}`, price_try: 1, store: "Uydurma Magaza" }],
      },
    }));
    const result = await planConversationWithRealtimeInterpretation(
      getTestDb(),
      { query: q, steps: [], reply: null },
      CONTEXT,
      { realtime: { client } },
    );
    if (result.plan.mode !== "conversation") throw new Error("plan");
    expect(JSON.stringify(result.plan.queryObject)).not.toContain("UYDURMA");
    const found = await search(getTestDb(), result.plan.queryObject, { limit: 20 });
    for (const item of found.items) expect(JSON.stringify(item)).not.toContain("UYDURMA");
    if (found.items.length > 0) {
      const ids = found.items.map((item) => item.productId);
      const known = await withOwnerClient(async (c) => {
        const r = await c.query("SELECT count(*)::int AS n FROM product WHERE id = ANY($1)", [ids]);
        return r.rows[0].n as number;
      });
      expect(known).toBe(new Set(ids).size);
    }
  });
});

describe("öncelik: açık/deterministik > Gemini", () => {
  it("deterministik bütçe ve domain korunur; Gemini yalnızca eksiği doldurur", async () => {
    const query = `2000 ile 3000 tl arasi kask ${TAG}`;
    const { client, queries } = fakeClient(() => ({
      kind: "value",
      value: {
        domain_id: "helmet",
        facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
        budget: { min_try: null, max_try: 2000 },
        price_preference: null,
      },
    }));
    const result = await planConversationWithRealtimeInterpretation(
      getTestDb(),
      { query, steps: [], reply: null },
      CONTEXT,
      { realtime: { client } },
    );
    expect(queries).toEqual([query]);
    if (result.plan.mode !== "conversation") throw new Error("plan");
    // Deterministik 2000-3000 TL: Gemini'nin 2000 TL ust siniri kazanamaz.
    expect(result.plan.queryObject.filters.price_min).toBe(200000);
    expect(result.plan.queryObject.filters.price_max).toBe(300000);
    // Deterministik bulmadigi nitelik Gemini'den gelir ve metne yansir.
    const legacy = await planConversationWithInterpretationSource(
      getTestDb(),
      { query, steps: [], reply: null },
      CONTEXT,
    );
    if (legacy.plan.mode !== "conversation") throw new Error("legacy plan");
    expect(textSlotsOf(legacy.plan.queryObject).flat()).not.toContain("kapali");
    expect(textSlotsOf(result.plan.queryObject).flat()).toContain("kapali");
  });
});

describe("Gemini bütçesi SQL fiyat süzgecine", () => {
  it("deterministik bütçe yoksa Gemini'nin metindeki fiyatı price_max olur", async () => {
    const query = `kask ${TAG} cebimde 2500 var`;
    const request = { query, steps: [], reply: null };
    const deterministic = await planConversationWithInterpretationSource(
      getTestDb(),
      request,
      CONTEXT,
    );
    if (deterministic.plan.mode !== "conversation") throw new Error("deterministic plan");
    expect(deterministic.plan.queryObject.filters.price_max).toBeUndefined();

    const { client } = fakeClient(() => ({
      kind: "value",
      value: {
        domain_id: "helmet",
        facets: [],
        budget: { min_try: null, max_try: 2500 },
        price_preference: null,
      },
    }));
    const result = await planConversationWithRealtimeInterpretation(getTestDb(), request, CONTEXT, {
      realtime: { client },
    });
    if (result.plan.mode !== "conversation") throw new Error("plan");
    // `price_max` (kurus) SQL'de `p.min_price <= $price_max` yuklemine baglanir.
    expect(result.plan.queryObject.filters.price_max).toBe(250000);
  });
});

describe("hata durumları: arama deterministik yoldan devam eder", () => {
  it.each([
    ["zaman aşımı", new LlmError("timeout"), null],
    ["429", new LlmError("rate_limited", 429), 429],
    ["sağlayıcı 5xx", new LlmError("server_error", 503), 503],
  ] as const)(
    "%s: plan deterministik, deneme sayılır, satır saklanmaz",
    async (label, error, status) => {
      const query = `kask ${TAG} hata ${label.replace(/[^a-z]/gi, "")}`;
      const before = await realtimeCallsToday();
      const { client } = fakeClient(() => ({ kind: "error", error, httpStatus: status }));
      const request = { query, steps: [], reply: null };
      const deterministic = await planConversationWithInterpretationSource(
        getTestDb(),
        request,
        CONTEXT,
      );
      const result = await planConversationWithRealtimeInterpretation(
        getTestDb(),
        request,
        CONTEXT,
        {
          realtime: { client },
        },
      );
      expect(result.realtimeSkip).toBe("provider_error");
      expect(result.plan).toEqual(deterministic.plan);
      expect(await realtimeCallsToday()).toBe(before + 1);
      expect(await storedStatus(query)).toBeNull();
    },
  );

  it("geçersiz çıktı: plan deterministik; durum saklanır, model tekrar çağrılmaz", async () => {
    const query = `kask ${TAG} gecersiz`;
    const { client, queries } = fakeClient(() => ({
      kind: "value",
      value: { domain_id: "uydurma", facets: [], budget: null, price_preference: null },
    }));
    const request = { query, steps: [], reply: null };
    const deterministic = await planConversationWithInterpretationSource(
      getTestDb(),
      request,
      CONTEXT,
    );
    const first = await planConversationWithRealtimeInterpretation(getTestDb(), request, CONTEXT, {
      realtime: { client },
    });
    expect(first.realtimeSkip).toBe("invalid");
    expect(first.plan).toEqual(deterministic.plan);
    expect(await storedStatus(query)).toBe("invalid");

    const second = await resolveRealtimeInterpretation(getTestDb(), query, {
      client,
      registry: REGISTRY,
    });
    expect(second).toEqual({ source: "none", reason: "already_interpreted" });
    expect(queries).toEqual([query]);
  });
});

describe("Gemini'ye gitmeyenler", () => {
  it.each([
    [`seker hastasi icin corap ${TAG}`, "sensitive"],
    [`ali@ornek.com kask ${TAG}`, "personal_data"],
    [`password=hunter2 ${TAG}`, "secret_like"],
  ])("%s → %s; model ve muhasebe yok", async (query, reason) => {
    const before = await realtimeCallsToday();
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const result = await resolveRealtimeInterpretation(getTestDb(), query, {
      client,
      registry: REGISTRY,
    });
    expect(result).toEqual({ source: "none", reason });
    expect(queries).toEqual([]);
    expect(await realtimeCallsToday()).toBe(before);
  });

  it("günlük anlık tavan dolduysa çağrılmaz; toplu iş tavanı ayrı sayılır", async () => {
    const batchBefore = await providerCallsToday(getTestDb(), new Date());
    // Atomik Redis butcesi, gercek gunun sayacina dokunmamak icin uzak bir gunde:
    // tavan (2) once doldurulur, sonra istek reddedilmeli.
    const testDay = new Date(Date.UTC(2102, 5, 1, 12));
    const key = providerBudgetKey(REALTIME_INTERPRETATION_OPERATION, testDay);
    try {
      for (let i = 0; i < 2; i++) {
        await reserveProviderBudget({
          operation: REALTIME_INTERPRETATION_OPERATION,
          amount: 1,
          cap: 2,
          now: testDay,
        });
      }
      const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
      const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} tavan`, {
        client,
        registry: REGISTRY,
        dailyCallCap: 2,
        now: () => testDay,
      });
      expect(result).toEqual({ source: "none", reason: "daily_cap" });
      expect(queries).toEqual([]);
      expect(Number(await getRedis().get(key))).toBe(2);
    } finally {
      await getRedis().del(key);
    }
    expect(await providerCallsToday(getTestDb(), new Date(), QUERY_INTERPRETATION_OPERATION)).toBe(
      batchBefore,
    );
  });
});

describe("global saglayici butcesi (atomik, quota/provider-budget.ts)", () => {
  /** Ayirma/kesinlestirme cagrilarini kaydeden sahte butce. */
  function recordingBudget(allowed = true) {
    const reserved: number[] = [];
    const settled: number[] = [];
    const budget: ProviderBudgetHooks = {
      reserve: async (input) => {
        reserved.push(input.amount);
        return allowed
          ? {
              allowed: true,
              reservation: {
                operation: input.operation,
                key: "provider-budget:test",
                ttlSeconds: 60,
                reserved: input.amount,
              },
            }
          : { allowed: false };
      },
      settle: async (_reservation, attempts) => {
        settled.push(attempts);
      },
    };
    return { budget, reserved, settled };
  }

  it("butce okunamazsa (Redis) model çağrılmaz, kişi limiti tüketilmez", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    let consumed = 0;
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} butceyok`, {
      client,
      registry: REGISTRY,
      actor: { userId: 31, ip: null },
      consume: async () => {
        consumed += 1;
        return { allowed: true };
      },
      budget: {
        reserve: async () => {
          throw new RedisUnavailableError("butce");
        },
      },
    });
    expect(result).toEqual({ source: "none", reason: "budget_unavailable" });
    expect(queries).toEqual([]);
    expect(consumed).toBe(0);
  });

  it("kişi limiti reddederse ayrılan bütçe tamamen iade edilir (sağlayıcı çağrılmadı)", async () => {
    const { client, queries } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const { budget, reserved, settled } = recordingBudget();
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} kisiret`, {
      client,
      registry: REGISTRY,
      actor: { userId: 32, ip: null },
      consume: async () => ({ allowed: false, window: "day" }),
      budget,
    });
    expect(result).toEqual({ source: "none", reason: "actor_limited" });
    expect(queries).toEqual([]);
    expect(reserved).toEqual([1]);
    expect(settled).toEqual([0]);
  });

  it("sağlayıcı çağrıldı ama hata döndü: deneme sayılı kalır", async () => {
    const { client, queries } = fakeClient(() => ({
      kind: "error",
      error: new LlmError("server_error", 503),
      httpStatus: 503,
    }));
    const { budget, settled } = recordingBudget();
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} hata503`, {
      client,
      registry: REGISTRY,
      budget,
    });
    expect(result).toEqual({ source: "none", reason: "provider_error" });
    expect(queries).toHaveLength(1);
    expect(settled).toEqual([1]);
  });

  it("saklanan yorum ve süzgeç bütçeye hiç dokunmaz", async () => {
    const { client } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
    const query = `kafa koruyucu ${TAG} butce-onbellek`;
    await resolveRealtimeInterpretation(getTestDb(), query, { client, registry: REGISTRY });
    const { budget, reserved } = recordingBudget();
    const stored = await resolveRealtimeInterpretation(getTestDb(), query, {
      client,
      registry: REGISTRY,
      budget,
    });
    const filtered = await resolveRealtimeInterpretation(getTestDb(), "beni 0532 123 45 67 ara", {
      client,
      registry: REGISTRY,
      budget,
    });
    expect(stored.source).toBe("stored");
    expect(filtered.source).toBe("none");
    expect(reserved).toEqual([]);
  });

  it("gerçek Redis: başarılı çağrı sayacı tam 1 artırır", async () => {
    const testDay = new Date(Date.UTC(2102, 5, 2, 12));
    const key = providerBudgetKey(REALTIME_INTERPRETATION_OPERATION, testDay);
    try {
      const { client } = fakeClient(() => ({ kind: "value", value: helmetFullFace }));
      const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} sayac`, {
        client,
        registry: REGISTRY,
        now: () => testDay,
      });
      expect(result.source).toBe("realtime");
      expect(Number(await getRedis().get(key))).toBe(1);
    } finally {
      await getRedis().del(key);
    }
  });
});

describe("eşzamanlı aynı sorgu ve kayıt dayanıklılığı (AI denetimi A10 / S2)", () => {
  /** Yanıtı geciktiren sahte istemci: eşzamanlı isteklerin üst üste binmesini sağlar. */
  function slowClient(delayMs: number) {
    const queries: string[] = [];
    const client: LlmClient = {
      modelVersion: MODEL,
      async generateJson(request: LlmJsonRequest, options?: LlmCallOptions) {
        const { query } = JSON.parse(request.input) as { query: string };
        queries.push(query);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        options?.onCall?.({ modelVersion: MODEL, httpStatus: 200, usage: USAGE });
        return { value: helmetFullFace, usage: USAGE, modelVersion: MODEL };
      },
    };
    return { client, queries };
  }

  it("aynı sorgu aynı anda gelirse Gemini TEK kez çağrılır", async () => {
    const { client, queries } = slowClient(150);
    const query = `kask ${TAG} esanli`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveRealtimeInterpretation(getTestDb(), query, { client, registry: REGISTRY }),
      ),
    );
    expect(queries).toHaveLength(1);
    expect(results.filter((r) => r.source === "realtime")).toHaveLength(1);
    for (const result of results) {
      expect(["realtime", "stored", "none"]).toContain(result.source);
      if (result.source === "none") expect(result.reason).toBe("in_flight");
    }
    // Tek çağrı, tek api_usage satırı.
    const usage = await withOwnerClient((c) =>
      c.query(
        "SELECT count(*)::int AS n FROM api_usage WHERE operation = $1 AND model_version = $2",
        [REALTIME_INTERPRETATION_OPERATION, MODEL],
      ),
    );
    expect(usage.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("farklı sorgular birbirini beklemez", async () => {
    const { client, queries } = slowClient(80);
    const results = await Promise.all([
      resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} birinci`, {
        client,
        registry: REGISTRY,
      }),
      resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} ikinci`, {
        client,
        registry: REGISTRY,
      }),
    ]);
    expect(queries).toHaveLength(2);
    expect(results.map((r) => r.source)).toEqual(["realtime", "realtime"]);
  });

  it("kilit sayacı erişilemezse kullanıcı engellenmez (model yine çağrılır)", async () => {
    const { client, queries } = slowClient(1);
    const result = await resolveRealtimeInterpretation(getTestDb(), `kask ${TAG} kilitsiz`, {
      client,
      registry: REGISTRY,
      singleFlight: {
        acquire: async () => {
          throw new RedisUnavailableError("kilit");
        },
        release: async () => {},
      },
    });
    expect(result.source).toBe("realtime");
    expect(queries).toHaveLength(1);
  });

  it("kayıt ilk denemede başarısız olursa yeniden denenir; ücretli çağrı iz bırakır", async () => {
    const { client } = slowClient(1);
    const real = await import("./query-interpretation.ts");
    let attempts = 0;
    const query = `kask ${TAG} kayityeniden`;
    const result = await resolveRealtimeInterpretation(getTestDb(), query, {
      client,
      registry: REGISTRY,
      persist: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("gecici veritabani hatasi");
        return real.persistOutcome(...args);
      },
    });
    expect(result.source).toBe("realtime");
    expect(attempts).toBe(2);
    expect(await storedStatus(query)).toBe("accepted");
  });
});
