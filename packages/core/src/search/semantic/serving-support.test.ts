import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import type { SemanticIndex } from "./active-index.ts";
import {
  descriptorsFromRows,
  loadCategoryStat,
  type PgIndexRow,
  resetInventoryCache,
} from "./inventory.ts";
import { createProviderHealth } from "./provider-health.ts";
import {
  classifyHttpFailure,
  createJinaQueryEmbedder,
  type QueryEmbedFailure,
} from "./query-embedder.ts";
import { measureSemanticShadow, type ShadowErrorLine, scheduleSemanticShadow } from "./shadow.ts";

const INDEX: SemanticIndex = {
  modelVersion: "jina-embeddings-v3",
  table: "product_text_embedding",
  dimensions: 768,
  queryTask: "retrieval.query",
};

describe("saglayici sagligi (anahtar tanimli != servis kullanilabilir)", () => {
  it("403/402/401 devreyi uzun sure acar; sure bitince tek deneme", () => {
    let t = 0;
    const h = createProviderHealth({}, () => t);
    expect(h.allow()).toBe(true);
    h.failure("quota");
    expect(h.allow()).toBe(false);
    t += 14 * 60_000;
    expect(h.allow()).toBe(false);
    t += 2 * 60_000;
    expect(h.snapshot().state).toBe("half_open");
    expect(h.allow()).toBe(true);
    expect(h.allow()).toBe(false); // yari acikta ikinci esanli deneme yok
    h.failure("quota");
    expect(h.snapshot().state).toBe("open");
    t += 16 * 60_000;
    expect(h.allow()).toBe(true);
    h.success();
    expect(h.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("gecici hata esige kadar devreyi acmaz", () => {
    let t = 0;
    const h = createProviderHealth({ failureThreshold: 3 }, () => t);
    h.failure("timeout");
    h.failure("server");
    expect(h.allow()).toBe(true);
    h.failure("network");
    expect(h.allow()).toBe(false);
    t += 31_000;
    expect(h.allow()).toBe(true);
  });

  it("429 kisa sure acar; diger 4xx acmaz", () => {
    let t = 0;
    const h = createProviderHealth({}, () => t);
    h.failure("client");
    expect(h.allow()).toBe(true);
    h.failure("rate_limited");
    expect(h.allow()).toBe(false);
    t += 61_000;
    expect(h.allow()).toBe(true);
  });

  it("sonuclanmayan yari acik deneme 10 sn sonra serbest kalir", () => {
    let t = 0;
    const h = createProviderHealth({}, () => t);
    h.failure("quota");
    t += 16 * 60_000;
    expect(h.allow()).toBe(true);
    expect(h.allow()).toBe(false);
    t += 11_000;
    expect(h.allow()).toBe(true);
  });
});

describe("sorgu embedding hata sinifi", () => {
  it.each([
    [401, "auth"],
    [402, "quota"],
    [403, "quota"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [400, "client"],
  ])("%i -> %s", (status, kind) => {
    expect(classifyHttpFailure(status)).toBe(kind);
  });

  it("Jina 403 Insufficient balance -> null + quota; govde/anahtar tasinmaz", async () => {
    const failures: QueryEmbedFailure[] = [];
    let successes = 0;
    const e = createJinaQueryEmbedder("gizli-anahtar", "jina-embeddings-v3", {
      cache: new Map(),
      fetch: async () =>
        new Response(JSON.stringify({ detail: "Insufficient balance" }), { status: 403 }),
      onFailure: (f) => failures.push(f),
      onSuccess: () => {
        successes += 1;
      },
    });
    expect(await e.embedQuery("kosu ayakkabisi")).toBeNull();
    expect(failures).toEqual(["quota"]);
    expect(successes).toBe(0);
  });

  it("zaman asimi -> timeout; bozuk yanit -> bad_payload; basari -> onSuccess", async () => {
    const failures: QueryEmbedFailure[] = [];
    let successes = 0;
    const make = (fetchImpl: typeof fetch) =>
      createJinaQueryEmbedder("k", "jina-embeddings-v3", {
        cache: new Map(),
        fetch: fetchImpl,
        onFailure: (f) => failures.push(f),
        onSuccess: () => {
          successes += 1;
        },
      });
    await make(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }).embedQuery("a");
    await make(
      async () => new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] })),
    ).embedQuery("b");
    const ok = new Array<number>(768).fill(0.01);
    await make(async () => new Response(JSON.stringify({ data: [{ embedding: ok }] }))).embedQuery(
      "c",
    );
    expect(failures).toEqual(["timeout", "bad_payload"]);
    expect(successes).toBe(1);
  });
});

function row(over: Partial<PgIndexRow>): PgIndexRow {
  return {
    name: "product_text_embedding_hnsw_jina_embeddings_v3_v1",
    table: "product_text_embedding",
    am: "hnsw",
    predicate: "(model_version = 'jina-embeddings-v3'::text)",
    opclass: "halfvec_cosine_ops",
    column: "embedding",
    column_type: "halfvec(768)",
    valid: true,
    ready: true,
    live: true,
    natts: 1,
    has_expressions: false,
    ...over,
  };
}

describe("envanter: pg_index satirlari", () => {
  it("dogru HNSW -> ready, model ve surum ad/kosuldan", () => {
    const { descriptors } = descriptorsFromRows([row({})], INDEX);
    expect(descriptors).toEqual([
      {
        id: "product_text_embedding_hnsw_jina_embeddings_v3_v1",
        kind: "global_hnsw",
        modelVersion: "jina-embeddings-v3",
        indexVersion: "1",
        scope: { type: "global" },
        state: "ready",
      },
    ]);
  });

  it.each([
    ["CONCURRENTLY suruyor", { valid: false, ready: false }, "building"],
    ["gecersiz", { valid: false, ready: true }, "invalid"],
    ["canli degil", { live: false }, "building"],
  ])("%s -> %s", (_n, over, state) => {
    expect(descriptorsFromRows([row(over)], INDEX).descriptors[0]?.state).toBe(state);
  });

  it.each([
    ["kosulsuz (karisik model)", { predicate: null }],
    ["baska kosul", { predicate: "(text_version = 1)" }],
    ["l2 opclass", { opclass: "halfvec_l2_ops" }],
    ["baska boyut", { column_type: "halfvec(1024)" }],
    ["ifade indeksi", { has_expressions: true }],
    ["cok kolonlu", { natts: 2 }],
  ])("%s -> envantere girmez", (_n, over) => {
    const r = descriptorsFromRows([row(over)], INDEX);
    expect(r.descriptors).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it("surumsuz ad -> indexVersion null (secici kullanmaz)", () => {
    expect(
      descriptorsFromRows([row({ name: "pte_hnsw" })], INDEX).descriptors[0]?.indexVersion,
    ).toBeNull();
  });

  it("product(category_id) B-tree -> btree_category; kismi ya da baska kolon degil", () => {
    const base = {
      table: "product",
      am: "btree",
      predicate: null,
      opclass: "int8_ops",
      column: "category_id",
      column_type: "bigint",
    };
    expect(
      descriptorsFromRows([row({ ...base, name: "product_category_idx" })], INDEX).descriptors,
    ).toEqual([
      {
        id: "product_category_idx",
        kind: "btree_category",
        modelVersion: null,
        indexVersion: null,
        scope: { type: "global" },
        state: "ready",
      },
    ]);
    expect(
      descriptorsFromRows([row({ ...base, name: "x", predicate: "(gtin IS NOT NULL)" })], INDEX)
        .descriptors,
    ).toEqual([]);
    expect(
      descriptorsFromRows([row({ ...base, name: "y", column: "brand_id" })], INDEX).descriptors,
    ).toEqual([]);
  });
});

describe("kategori istatistigi", () => {
  it("onbellek ve hata -> null", async () => {
    resetInventoryCache();
    const db = {} as Database;
    let calls = 0;
    const req = { index: INDEX, modelVersion: "m", path: "moda", cap: 2000, timeoutMs: 100 };
    const count = async () => {
      calls += 1;
      return 12;
    };
    const t = 1_000_000;
    expect((await loadCategoryStat(db, req, { count, now: () => t }))?.rows).toBe(12);
    expect((await loadCategoryStat(db, req, { count, now: () => t + 1000 }))?.rows).toBe(12);
    expect(calls).toBe(1);
    expect(
      await loadCategoryStat(
        db,
        { ...req, path: "elektronik" },
        {
          count: async () => {
            throw new Error("57014");
          },
        },
      ),
    ).toBeNull();
  });
});

describe("golge: hatalar artik sessiz degil (karar 0190)", () => {
  const db = {} as Database;
  const shadowInput = {
    semanticText: "kosu ayakkabisi",
    queryText: "kosu ayakkabisi",
    filters: {},
    textItems: [],
  };

  it("olcu satiri yazilamazsa yapisal hata satiri", async () => {
    const lines: ShadowErrorLine[] = [];
    await measureSemanticShadow(db, shadowInput, {
      env: { SEMANTIC_SEARCH_MODE: "shadow" },
      random: () => 0,
      resolveIndex: async () => ({ index: null, reason: "no_active_index", modelVersion: "m" }),
      record: async () => {
        throw Object.assign(new Error("permission denied for table x with secret"), {
          code: "42501",
        });
      },
      logError: (l) => lines.push(l),
    });
    expect(lines).toEqual([
      { event: "semantic_shadow_error", stage: "record_failed", reason: "pg_42501" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("olcum hatasi (error sonucu) da gunluge yazilir", async () => {
    const lines: ShadowErrorLine[] = [];
    await measureSemanticShadow(db, shadowInput, {
      env: { SEMANTIC_SEARCH_MODE: "shadow" },
      random: () => 0,
      resolveIndex: async () => {
        throw new RangeError("boom");
      },
      record: async () => undefined,
      logError: (l) => lines.push(l),
    });
    expect(lines).toEqual([
      { event: "semantic_shadow_error", stage: "measure_failed", reason: "rangeerror" },
    ]);
  });

  it("zamanlanmis olcum aramayi bekletmez ve beklenmeyen hatayi gunluge yazar", async () => {
    const lines: ShadowErrorLine[] = [];
    // `measureSemanticShadow`in try blogundan ONCE okunan ayar firlatir (programlama hatasi benzetimi).
    const env = new Proxy(
      { SEMANTIC_SEARCH_MODE: "shadow" } as Record<string, string | undefined>,
      {
        get(target, key) {
          if (key === "SEMANTIC_EMBEDDING_MODEL") throw new SyntaxError("x");
          return target[key as string];
        },
      },
    );
    const task = scheduleSemanticShadow(db, shadowInput, {
      env,
      logError: (l) => lines.push(l),
    });
    expect(task).not.toBeNull();
    expect(await task).toBeNull();
    expect(lines).toEqual([
      { event: "semantic_shadow_error", stage: "unexpected", reason: "syntaxerror" },
    ]);
  });
});
