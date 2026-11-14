import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import canaryJson from "./golden/bge-m3-5617a9f6-query-canary.json" with { type: "json" };
import {
  type CanaryResult,
  canaryGateFor,
  canaryStatus,
  createCanaryGate,
  type QueryCanaryData,
  resetCanaryGates,
  runQueryCanary,
  withCanaryGate,
} from "./query-canary.ts";
import type { QueryEmbedder, QueryEmbedResult } from "./query-embedder.ts";

const data: QueryCanaryData = {
  model_id: "x",
  min_cosine: 0.99,
  dimensions: 3,
  cases: [
    { text: "bir", vector: [1, 0, 0] },
    { text: "iki", vector: [0, 1, 0] },
  ],
};

const embedderFrom = (map: Record<string, number[] | null>): QueryEmbedder => ({
  modelVersion: "x",
  async embedQuery(text: string): Promise<QueryEmbedResult | null> {
    const v = map[text];
    return v ? { vector: v, cacheHit: false, latencyMs: 1 } : null;
  },
});

describe("runQueryCanary", () => {
  it("referansla ayni vektor -> ok", async () => {
    const r = await runQueryCanary(embedderFrom({ bir: [1, 0, 0], iki: [0, 1, 0] }), data);
    expect(r).toMatchObject({ ok: true, reason: "ok" });
    expect(r.minCosine).toBeCloseTo(1, 6);
  });

  it("farkli uzay (ornek yanlis havuzlama) -> esigin altinda", async () => {
    const r = await runQueryCanary(embedderFrom({ bir: [0.8, 0.6, 0], iki: [0, 1, 0] }), data);
    expect(r).toMatchObject({ ok: false, reason: "below_threshold" });
    expect(r.minCosine).toBeCloseTo(0.8, 5);
  });

  it("servis vektor vermezse ve boyut uyusmazsa -> basarisiz", async () => {
    expect(await runQueryCanary(embedderFrom({ bir: [1, 0, 0] }), data)).toMatchObject({
      ok: false,
      reason: "no_vector",
    });
    expect(await runQueryCanary(embedderFrom({ bir: [1, 0], iki: [0, 1, 0] }), data)).toMatchObject(
      { ok: false, reason: "dimension_mismatch" },
    );
  });

  it("embedder firlatsa bile firlatmaz", async () => {
    const throwing: QueryEmbedder = {
      modelVersion: "x",
      async embedQuery() {
        throw new Error("x");
      },
    };
    expect(await runQueryCanary(throwing, data)).toMatchObject({ ok: false });
  });
});

describe("kapi", () => {
  const tick = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("ilk kullanimda arka planda calisir; gecene kadar sorgu vektoru null; sonra gecer", async () => {
    let release: (r: CanaryResult) => void = () => undefined;
    let runs = 0;
    const gate = createCanaryGate({
      run: () => {
        runs += 1;
        return new Promise<CanaryResult>((resolve) => {
          release = resolve;
        });
      },
    });
    const inner = embedderFrom({ q: [1, 0, 0] });
    const guarded = withCanaryGate(inner, gate);
    expect(await guarded.embedQuery("q")).toBeNull();
    expect(await guarded.embedQuery("q")).toBeNull();
    expect(runs).toBe(1); // tek ucus
    expect(gate.state()).toBe("running");
    release({ ok: true, minCosine: 0.9999, reason: "ok" });
    await tick();
    expect(gate.state()).toBe("passed");
    expect((await guarded.embedQuery("q"))?.vector).toEqual([1, 0, 0]);
  });

  it("basarisiz kanarya gercek vektoru KAPATIR ve geri cekilme suresinden sonra yeniden dener", async () => {
    let t = 0;
    let runs = 0;
    const results: CanaryResult[] = [
      { ok: false, minCosine: 0.5, reason: "below_threshold" },
      { ok: true, minCosine: 0.9999, reason: "ok" },
    ];
    const gate = createCanaryGate({
      run: async () => results[runs++] as CanaryResult,
      now: () => t,
      failBackoffMs: 1000,
    });
    const guarded = withCanaryGate(embedderFrom({ q: [1, 0, 0] }), gate);
    await guarded.embedQuery("q");
    await tick();
    expect(gate.state()).toBe("failed");
    t = 500;
    expect(await guarded.embedQuery("q")).toBeNull();
    expect(runs).toBe(1); // geri cekilme suresinde yeniden denenmez
    t = 1500;
    expect(await guarded.embedQuery("q")).toBeNull(); // yeniden deneme baslar; hala kapali
    await tick();
    expect(runs).toBe(2);
    expect(gate.state()).toBe("passed");
  });

  it("TTL dolunca arka planda yeniden dogrular; dogrulama sirasinda kapi acik kalir, basarisizsa kapanir", async () => {
    let t = 0;
    let runs = 0;
    const results: CanaryResult[] = [
      { ok: true, minCosine: 1, reason: "ok" },
      { ok: false, minCosine: 0.2, reason: "below_threshold" },
    ];
    const gate = createCanaryGate({
      run: async () => results[runs++] as CanaryResult,
      now: () => t,
      passTtlMs: 1000,
    });
    const guarded = withCanaryGate(embedderFrom({ q: [1, 0, 0] }), gate);
    await guarded.embedQuery("q");
    await tick();
    expect(gate.state()).toBe("passed");
    t = 2000;
    expect((await guarded.embedQuery("q"))?.vector).toEqual([1, 0, 0]); // eski basari gecerli
    await tick();
    expect(runs).toBe(2);
    expect(gate.state()).toBe("failed"); // kayma yakalandi
    expect(await guarded.embedQuery("q")).toBeNull();
  });

  it("calistirma hatasi kapiyi basarisiz yapar (firlatmaz)", async () => {
    const gate = createCanaryGate({
      run: async () => {
        throw new Error("x");
      },
    });
    gate.kick();
    await tick();
    expect(gate.state()).toBe("failed");
  });

  it("surec geneli kapi model basina tek ve izlenebilir", () => {
    resetCanaryGates();
    let made = 0;
    const make = () => {
      made += 1;
      return createCanaryGate({ run: async () => ({ ok: true, minCosine: 1, reason: "ok" }) });
    };
    expect(canaryGateFor("m", make)).toBe(canaryGateFor("m", make));
    expect(made).toBe(1);
    expect(canaryStatus().m?.state).toBe("unknown");
    resetCanaryGates();
  });
});

describe("altin sorgu verisi: Python altin dosyasiyla BIREBIR (parite)", () => {
  it("sorgu amacli vakalar, esik, boyut ve revizyon ayni", () => {
    const url = new URL(
      "../../../../../services/ingest/enrich/golden/bge-m3-5617a9f6.json",
      import.meta.url,
    );
    const python = JSON.parse(readFileSync(url, "utf8")) as {
      model_id: string;
      source: { revision: string };
      dimensions: number;
      pooling: string;
      tolerance: { min_cosine: number };
      cases: { purpose: string; text: string; vector: number[] }[];
    };
    const ts = canaryJson as unknown as QueryCanaryData & {
      source_revision: string;
      pooling: string;
    };
    expect(ts.model_id).toBe(python.model_id);
    expect(ts.source_revision).toBe(python.source.revision);
    expect(ts.pooling).toBe("cls");
    expect(ts.dimensions).toBe(python.dimensions);
    expect(ts.min_cosine).toBe(python.tolerance.min_cosine);
    expect(ts.cases).toEqual(
      python.cases
        .filter((c) => c.purpose === "query")
        .map((c) => ({ text: c.text, vector: c.vector })),
    );
    expect(ts.cases.length).toBeGreaterThanOrEqual(4);
  });
});
