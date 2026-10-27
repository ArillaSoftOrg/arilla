/**
 * Anlik Gemini yorumu (karar 0062): dogrulama ve derleme zinciri, ag ve veritabani YOK.
 *
 * Gemini yerine sorguya gore cevap veren sahte bir `LlmClient`, veritabani yerine
 * yalnizca onbellek okumasini taklit eden kucuk bir saplama kullanilir. Geri kalani
 * GERCEK koddur: `resolveRealtimeInterpretation` -> `validateInterpretation` ->
 * `applyInterpretation` -> `compileQuery`. Boylece modelin ne dondurdugunun arama
 * nesnesine (`QueryObject`) nasil yansidigi kanitlanir.
 *
 * Sinir: model yalnizca taksonomideki kimlikleri secer. Renk, marka ve kategori icin
 * ciktisinda alan YOKTUR; bu eksikligi gidermez (katalogda `color`/`category_id` bos,
 * `lexicon`'da renk/marka girdisi yok). Testler bunu bilerek sabitler.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { planConversationWithRealtimeInterpretation } from "../conversational-search/stored-plan.ts";
import type { LlmCall, LlmClient, LlmJsonRequest } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import type { ProviderBudgetHooks } from "../quota/provider-budget.ts";
import type { QuotaConsumer } from "../quota/redis-windows.ts";
import {
  type RealtimeInterpretationOptions,
  resolveRealtimeInterpretation,
} from "./realtime-interpretation.ts";
import { textSlotsOf } from "./search-sql.ts";

const REGISTRY = DEFAULT_CLARIFICATION_REGISTRY;
const CONTEXT = { registry: REGISTRY, lexicon: [] };
const MODEL = "fake-gemini";
const USAGE = { inputTokens: 90, outputTokens: 10, thoughtTokens: 0, totalTokens: 100 };

type Reply = unknown | LlmError;

interface Harness {
  options: RealtimeInterpretationOptions;
  /** Modele giden istekler (sorgu + sema + talimat). */
  requests: LlmJsonRequest[];
  persisted: { status: string; calls: number }[];
  budget: { reserved: number; settled: number[] };
}

/** `db`: yalnizca `readStoredRow`un zinciri (`select().from().where().limit()`). */
function stubDb(stored: { status: string; interpretation: unknown } | null) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (stored ? [stored] : []),
  };
  return { select: () => chain } as never;
}

function harness(
  reply: (query: string) => Reply,
  extra: Partial<RealtimeInterpretationOptions> = {},
) {
  const requests: LlmJsonRequest[] = [];
  const persisted: Harness["persisted"] = [];
  const budget: Harness["budget"] = { reserved: 0, settled: [] };
  const client: LlmClient = {
    modelVersion: MODEL,
    async generateJson(request, options) {
      requests.push(request);
      const { query } = JSON.parse(request.input) as { query: string };
      const answer = reply(query);
      if (answer instanceof LlmError) {
        options?.onCall?.({ modelVersion: MODEL, httpStatus: null, usage: null });
        throw answer;
      }
      const call: Omit<LlmCall, "modelVersion"> = { httpStatus: 200, usage: USAGE };
      options?.onCall?.({ modelVersion: MODEL, ...call });
      return { value: answer, usage: USAGE, modelVersion: MODEL };
    },
  };
  const hooks: ProviderBudgetHooks = {
    reserve: async (input) => {
      budget.reserved += input.amount;
      return {
        allowed: true,
        reservation: {
          operation: input.operation,
          key: "k",
          ttlSeconds: 1,
          reserved: input.amount,
        },
      } as never;
    },
    settle: async (_reservation, attempts) => {
      budget.settled.push(attempts);
    },
  };
  const consume: QuotaConsumer = async () => ({ allowed: true });
  const options: RealtimeInterpretationOptions = {
    client,
    registry: REGISTRY,
    budget: hooks,
    consume,
    actor: { userId: 7, ip: null },
    singleFlight: { acquire: async () => true, release: async () => undefined },
    persist: async (_db, input) => {
      persisted.push({ status: input.outcome.status, calls: input.outcome.calls.length });
      return { stored: true, conflict: false };
    },
    ...extra,
  };
  return { options, requests, persisted, budget } satisfies Harness;
}

const empty = { domain_id: null, facets: [], budget: null, price_preference: null };

/** Bir sorgunun anlik yorumlu planini kurar ve derlenmis sorgu nesnesini dondurur. */
async function plan(query: string, h: Harness, stored: Parameters<typeof stubDb>[0] = null) {
  const result = await planConversationWithRealtimeInterpretation(
    stubDb(stored),
    { query, steps: [], reply: null },
    CONTEXT,
    { realtime: h.options },
  );
  return result;
}

describe("Gemini yorumu arama nesnesini nasil degistirir", () => {
  it("kırmızı şort: taksonomide şort yok; model bir şey seçemez, arama aynen sürer", async () => {
    const h = harness(() => empty);
    const result = await plan("kırmızı şort", h);
    expect(h.requests).toHaveLength(1);
    expect(result.plan.mode).toBe("conventional");
    expect(result.realtimeSkip).toBe("empty");
    // Yorum bos: ozet yok, kullaniciya "yapay zeka yorumu" gosterilmez.
    expect(result.summaryIntent).toBeNull();
    if (result.plan.mode === "conventional") expect(result.plan.query).toBe("kırmızı şort");
  });

  it("kırmızı şort: modelin taksonomi dışı kimlik uydurması reddedilir (domain ve renk)", async () => {
    const h = harness(() => ({
      domain_id: "shorts",
      facets: [{ facet_id: "color", option_id: "red" }],
      budget: null,
      price_preference: null,
      color: "kirmizi",
      brand: "Nike",
    }));
    const result = await plan("kırmızı şort", h);
    expect(result.plan.mode).toBe("conventional");
    expect(h.persisted).toEqual([{ status: "invalid", calls: 1 }]);
  });

  it("1500 TL altı erkek spor ayakkabısı: bütçe kuruş, cinsiyet ve tür taksonomiden", async () => {
    const h = harness(() => ({
      domain_id: "shoes",
      facets: [
        { facet_id: "audience", option_id: "men" },
        { facet_id: "shoe_type", option_id: "sneaker" },
      ],
      budget: { min_try: null, max_try: 1500 },
      price_preference: null,
    }));
    const { plan: p } = await plan("1500 TL altı erkek spor ayakkabısı", h);
    expect(p.mode).toBe("conversation");
    if (p.mode !== "conversation") return;
    expect(p.domainId).toBe("shoes");
    expect(p.queryObject.filters.price_max).toBe(150_000);
    expect(p.queryObject.filters.price_min).toBeUndefined();
    const slots = textSlotsOf(p.queryObject).flat();
    expect(slots).toEqual(expect.arrayContaining(["erkek", "ayakkabi"]));
  });

  it("siyah Samsung telefon: alan yalnızca telefon; renk/marka modelden süzgece GİRMEZ", async () => {
    const h = harness(() => ({
      domain_id: "phone",
      facets: [],
      budget: null,
      price_preference: null,
      color: "siyah",
      brand: "samsung",
    }));
    const { plan: p } = await plan("siyah Samsung telefon", h);
    expect(p.mode).toBe("conversation");
    if (p.mode !== "conversation") return;
    expect(p.queryObject.filters.category_path).toBe("elektronik");
    // Sema disi alanlar yok sayilir; renk ve marka metinde kalir (lexicon bos oldugu icin
    // kapida baslik kelimesi olarak aranir), `color`/`brand_include` filtresi uretilmez.
    expect(p.queryObject.filters.color).toBeUndefined();
    expect(p.queryObject.filters.brand_include).toBeUndefined();
    expect(p.queryObject.unparsed).toContain("samsung");
  });

  it("oyuncu kulaklığı: elektronik / kulaklık tür seçimi, kategori elektronik", async () => {
    const h = harness(() => ({
      domain_id: "electronics",
      facets: [{ facet_id: "electronics_type", option_id: "headphones" }],
      budget: null,
      price_preference: null,
    }));
    const { plan: p, summaryIntent } = await plan("oyuncu kulaklığı", h);
    expect(p.mode).toBe("conversation");
    if (p.mode !== "conversation") return;
    expect(p.domainId).toBe("electronics");
    expect(p.queryObject.filters.category_path).toBe("elektronik");
    expect(summaryIntent).not.toBeNull();
  });

  it("32 GB RAM laptop: laptop domain'i; RAM özelliği süzgece ya da kapıya girmez", async () => {
    const h = harness(() => ({
      domain_id: "laptop",
      facets: [],
      budget: null,
      price_preference: null,
    }));
    const { plan: p } = await plan("32 GB RAM laptop", h);
    expect(p.mode).toBe("conversation");
    if (p.mode !== "conversation") return;
    expect(p.domainId).toBe("laptop");
    expect(p.queryObject.filters.category_path).toBe("elektronik");
    // modelOnly urun turu: katalogda karsiligi olmayan "32 gb ram" kapiyi bosaltmasin.
    expect(p.queryObject.unparsed).not.toMatch(/ram/);
    expect(p.queryObject.filters.size_norm).toBeUndefined();
  });

  it("uygun fiyatlı kablosuz fare: fiyat tercihi süzgeç/sıralama değildir, fiyat uydurulmaz", async () => {
    const h = harness(() => ({
      domain_id: "electronics",
      facets: [{ facet_id: "electronics_type", option_id: "peripherals" }],
      budget: null,
      price_preference: "lower",
    }));
    const { plan: p } = await plan("uygun fiyatlı kablosuz fare", h);
    expect(p.mode).toBe("conversation");
    if (p.mode !== "conversation") return;
    expect(p.queryObject.filters.price_max).toBeUndefined();
    expect(p.queryObject.filters.price_min).toBeUndefined();
    expect(p.queryObject.sort).toBe("balanced");
  });
});

describe("Doğrulama: model çıktısı ASLA doğrudan aramaya girmez", () => {
  it("metinde olmayan bütçe reddedilir", async () => {
    const h = harness(() => ({
      domain_id: "laptop",
      facets: [],
      budget: { min_try: null, max_try: 12_345 },
      price_preference: null,
    }));
    const r = await resolveRealtimeInterpretation(stubDb(null), "32 gb ram laptop", h.options);
    expect(r.source).toBe("realtime");
    if (r.source === "realtime") expect(r.interpretation.budget).toBeNull();
  });

  it("başka domain'in niteliği atılır (ayakkabı niteliği telefona uygulanmaz)", async () => {
    const h = harness(() => ({
      domain_id: "phone",
      facets: [{ facet_id: "shoe_type", option_id: "boot" }],
      budget: null,
      price_preference: null,
    }));
    const r = await resolveRealtimeInterpretation(stubDb(null), "siyah samsung telefon", h.options);
    expect(r.source).toBe("realtime");
    if (r.source === "realtime") expect(r.interpretation.facets).toEqual([]);
  });

  it("nesne olmayan çıktı kullanılmaz; arama deterministik sürer", async () => {
    const h = harness(() => "merhaba");
    const { plan: p, realtimeSkip } = await plan("oyuncu kulaklığı", h);
    expect(p.mode).toBe("conventional");
    expect(realtimeSkip).toBe("invalid");
  });
});

describe("Gemini yanıt vermezse kullanıcı hata görmez", () => {
  it.each([
    ["timeout", "provider_error"],
    ["rate_limited", "provider_error"],
    ["server_error", "provider_error"],
    ["auth", "provider_error"],
    ["network", "provider_error"],
  ] as const)("%s -> conventional plan, fırlatma yok", async (code, skip) => {
    const h = harness(() => new LlmError(code));
    const result = await plan("oyuncu kulaklığı", h);
    expect(result.plan.mode).toBe("conventional");
    expect(result.realtimeSkip).toBe(skip);
    // Ucretli deneme yine kayda gecer (api_usage) ve butce kesinlestirilir.
    expect(h.persisted).toHaveLength(1);
    expect(h.budget.settled).toEqual([1]);
  });

  it("bozuk JSON / kesik çıktı `invalid` saklanır, plan deterministik", async () => {
    const h = harness(() => new LlmError("invalid_json"));
    const result = await plan("oyuncu kulaklığı", h);
    expect(result.plan.mode).toBe("conventional");
    expect(h.persisted).toEqual([{ status: "invalid", calls: 1 }]);
  });

  it("veritabanı okuması patlarsa bile fırlatmaz", async () => {
    const h = harness(() => empty);
    const brokenDb = {
      select: () => {
        throw new Error("db down");
      },
    } as never;
    const r = await resolveRealtimeInterpretation(brokenDb, "oyuncu kulaklığı", h.options);
    expect(r).toEqual({ source: "none", reason: "error" });
    expect(h.requests).toHaveLength(0);
  });

  it("yazma (api_usage) hatası yorumu kullanılamaz yapmaz", async () => {
    const h = harness(
      () => ({ domain_id: "laptop", facets: [], budget: null, price_preference: null }),
      {
        persist: async () => {
          throw new Error("write failed");
        },
      },
    );
    const r = await resolveRealtimeInterpretation(stubDb(null), "32 gb ram laptop", h.options);
    expect(r.source).toBe("realtime");
  });
});

describe("Maliyet ve limit korumaları", () => {
  it("bayrak kapalı: model çağrılmaz (varsayılan)", async () => {
    const h = harness(() => empty);
    const { client: _client, ...rest } = h.options;
    const r = await resolveRealtimeInterpretation(stubDb(null), "oyuncu kulaklığı", {
      ...rest,
      env: { GEMINI_API_KEY: "x" },
    });
    expect(r).toEqual({ source: "none", reason: "disabled" });
    expect(h.requests).toHaveLength(0);
  });

  it("bayrak açık ama anahtar yok: model çağrılmaz", async () => {
    const h = harness(() => empty);
    const { client: _client, ...rest } = h.options;
    const r = await resolveRealtimeInterpretation(stubDb(null), "oyuncu kulaklığı", {
      ...rest,
      env: { GEMINI_REALTIME_ENABLED: "true" },
    });
    expect(r).toEqual({ source: "none", reason: "disabled" });
  });

  it("saklanan kabul edilmiş yorum yeniden kullanılır: ikinci Gemini çağrısı yok", async () => {
    const h = harness(() => empty);
    const stored = {
      status: "accepted",
      interpretation: { domainId: "laptop", facets: [], budget: null, pricePreference: null },
    };
    const r = await resolveRealtimeInterpretation(stubDb(stored), "32 gb ram laptop", h.options);
    expect(r.source).toBe("stored");
    expect(h.requests).toHaveLength(0);
    expect(h.budget.reserved).toBe(0);
  });

  it("boş/geçersiz saklanan yorum için model tekrar çağrılmaz", async () => {
    const h = harness(() => empty);
    const r = await resolveRealtimeInterpretation(
      stubDb({ status: "invalid", interpretation: null }),
      "kırmızı şort",
      h.options,
    );
    expect(r).toEqual({ source: "none", reason: "already_interpreted" });
    expect(h.requests).toHaveLength(0);
  });

  it("günlük tavan dolu: model çağrılmaz", async () => {
    const h = harness(() => empty, {
      budget: { reserve: async () => ({ allowed: false }) as never },
    });
    const r = await resolveRealtimeInterpretation(stubDb(null), "oyuncu kulaklığı", h.options);
    expect(r).toEqual({ source: "none", reason: "daily_cap" });
    expect(h.requests).toHaveLength(0);
  });

  it("kişi başına limit dolu: model çağrılmaz", async () => {
    const h = harness(() => empty, {
      consume: async () => ({ allowed: false, window: "hour" }) as never,
    });
    const r = await resolveRealtimeInterpretation(stubDb(null), "oyuncu kulaklığı", h.options);
    expect(r).toEqual({ source: "none", reason: "actor_limited" });
    expect(h.requests).toHaveLength(0);
  });

  it("aynı sorgu başka istekte yorumlanıyorsa ikinci çağrı yapılmaz", async () => {
    const h = harness(() => empty, {
      singleFlight: { acquire: async () => false, release: async () => undefined },
    });
    const r = await resolveRealtimeInterpretation(stubDb(null), "oyuncu kulaklığı", h.options);
    expect(r).toEqual({ source: "none", reason: "in_flight" });
    expect(h.requests).toHaveLength(0);
  });

  it("kişisel veri içeren sorgu modele gitmez", async () => {
    const h = harness(() => empty);
    const r = await resolveRealtimeInterpretation(
      stubDb(null),
      "ahmet@example.com laptop",
      h.options,
    );
    expect(r.source).toBe("none");
    expect(h.requests).toHaveLength(0);
  });
});

describe("Modele giden istek", () => {
  it("yalnızca sorgu, durum ve taksonomi gider; kimlik yok; şema katı", async () => {
    const h = harness(() => empty);
    await resolveRealtimeInterpretation(stubDb(null), "oyuncu kulaklığı", {
      ...h.options,
      actor: { userId: 4242, ip: null },
    });
    const [request] = h.requests;
    expect(request).toBeDefined();
    const wire = JSON.stringify(request);
    expect(wire).not.toContain("4242");
    const schema = request?.schema as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["domain_id", "facets", "budget", "price_preference"]);
    expect(Object.keys(JSON.parse(request?.input ?? "{}"))).toEqual([
      "query",
      "current",
      "taxonomy",
    ]);
  });
});
