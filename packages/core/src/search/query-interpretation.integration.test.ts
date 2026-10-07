/**
 * Karar 0059 / migration 0044 — cevrimdisi sorgu yorumu toplu isi, gercek
 * yerel Postgres, sahte LLM istemcisi (ag YOK).
 *
 * Yalitim: her kosu kendi sahte model surumunu (`fake-qi-<sonek>`) ve
 * taksonomi varyantini kullanir; yazdigi onbellek ve `api_usage` satirlari
 * yalnizca bunlarla eslesir ve temizlenir. Test sorgulari en yuksek arama
 * sayisiyla yazilir ki yerel veritabanindaki baska sorgulardan once secilsin.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import type { LlmCall, LlmCallOptions, LlmClient, LlmJsonRequest } from "../llm/client.ts";
import { LlmError } from "../llm/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { interpreterContractHash } from "./interpretation-identity.ts";
import {
  providerCallsToday,
  purgeExpiredQueryInterpretations,
  QUERY_INTERPRETATION_DAILY_CALL_CAP,
  QUERY_INTERPRETATION_JOB,
  QUERY_INTERPRETATION_OPERATION,
  QUERY_INTERPRETATION_RETENTION_DAYS,
  runQueryInterpretationBatch,
  runQueryInterpretationJob,
  selectInterpretationCandidates,
} from "./query-interpretation.ts";

const S = Date.now().toString(36);
const MODEL = `fake-qi-${S}`;
const MODEL_2 = `fake-qi2-${S}`;
const Q_ACCEPT = `qi${S} lumbarzyx`;
const Q_INVALID = `qi${S} nobelxq`;
const Q_PROVIDER = `qi${S} provfail`;
const Q_EMAIL = `qi${S} ali@ornek.com`;
const Q_SECRET = `qi${S} password=hunter2`;
const Q_RARE = `qi${S} nadiren`;
const Q_DOMAIN = `kask qi${S}`;
/** Tek gunde cok arama: tek kisi tekrari gibi; farkli gun esigi nedeniyle hic secilmez. */
const Q_ONE_DAY = `qi${S} tekgun`;
/** Ozel nitelikli veri baglami (saglik): uygunluk suzgeci eler. */
const Q_SENSITIVE = `qi${S} seker hastasi icin corap`;
const OURS = [Q_ACCEPT, Q_INVALID, Q_PROVIDER];

/** Taksonomi varyanti: bu kosuya ozel ozet; gercek ozetle karismaz. */
function registryVariant(tag: string): ClarificationRegistry {
  const base = DEFAULT_CLARIFICATION_REGISTRY;
  const [first, ...rest] = base.domains;
  if (!first) throw new Error("taksonomi bos");
  const [facet, ...others] = first.facets;
  if (!facet) throw new Error("faset yok");
  return {
    ...base,
    domains: [
      { ...first, facets: [{ ...facet, question: `${facet.question} ${tag}` }, ...others] },
      ...rest,
    ],
  };
}
const REGISTRY = registryVariant(`qi-${S}`);
const REGISTRY_2 = registryVariant(`qi2-${S}`);

const OK_CALL = (model: string): LlmCall => ({
  modelVersion: model,
  httpStatus: 200,
  usage: { inputTokens: 90, outputTokens: 10, thoughtTokens: 3, totalTokens: 103 },
});

/** Sorguya gore cevap veren sahte istemci; her istegin girdisini kaydeder. */
function fakeClient(model: string) {
  const inputs: unknown[] = [];
  const client: LlmClient = {
    modelVersion: model,
    async generateJson(request: LlmJsonRequest, options?: LlmCallOptions) {
      const input = JSON.parse(request.input) as { query: string };
      inputs.push(input);
      if (input.query === Q_PROVIDER) {
        options?.onCall?.({ modelVersion: model, httpStatus: 503, usage: null });
        options?.onCall?.({ modelVersion: model, httpStatus: null, usage: null });
        throw new LlmError("server_error", 503);
      }
      options?.onCall?.(OK_CALL(model));
      const value =
        input.query === Q_ACCEPT
          ? {
              domain_id: "helmet",
              facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
              budget: null,
              price_preference: null,
            }
          : input.query === Q_INVALID
            ? { domain_id: "uydurma", facets: [], budget: null, price_preference: null }
            : { domain_id: null, facets: [], budget: null, price_preference: null };
      const usage = { inputTokens: 90, outputTokens: 10, thoughtTokens: 3, totalTokens: 103 };
      return { value, usage, modelVersion: model };
    },
  };
  return { client, inputs };
}

async function cacheRows(model: string) {
  return withOwnerClient(async (c) => {
    const r = await c.query(
      `SELECT query_norm, taxonomy_hash, status, interpretation, rejected
         FROM query_interpretation WHERE model_version = $1 ORDER BY query_norm`,
      [model],
    );
    return r.rows as {
      query_norm: string;
      taxonomy_hash: string;
      status: string;
      interpretation: unknown;
      rejected: unknown;
    }[];
  });
}

async function usageRows(model: string) {
  return withOwnerClient(async (c) => {
    const r = await c.query(
      `SELECT operation, model_version, units, cost_micros, cache_hit, user_id, session_id
         FROM api_usage WHERE model_version = $1 ORDER BY id`,
      [model],
    );
    return r.rows;
  });
}

/** `job_run` imleci: Node ve Postgres saatleri ayrisabilir, kimlik ayrismaz. */
async function lastJobRunId(): Promise<number> {
  return withOwnerClient(async (c) => {
    const r = await c.query("SELECT coalesce(max(id), 0) AS id FROM job_run");
    return Number(r.rows[0].id);
  });
}

async function jobRows(afterId: number) {
  return withOwnerClient(async (c) => {
    const r = await c.query(
      `SELECT id, status, detail, error_summary FROM job_run
        WHERE job = $1 AND id > $2 ORDER BY id`,
      [QUERY_INTERPRETATION_JOB, afterId],
    );
    return r.rows as { id: string; status: string; detail: Record<string, unknown> }[];
  });
}

describe("query_interpretation - entegrasyon", () => {
  let db: Database;
  let jobCursor = 0;

  beforeAll(async () => {
    db = getTestDb();
    jobCursor = await lastJobRunId();
    await withOwnerClient(async (c) => {
      // [sorgu, gun basina arama, farkli gun sayisi]
      const rows: [string, number, number][] = [
        [Q_ONE_DAY, 999_999, 1],
        [Q_EMAIL, 33_330, 3],
        [Q_SECRET, 33_327, 3],
        [Q_SENSITIVE, 33_325, 3],
        [Q_DOMAIN, 33_323, 3],
        [Q_ACCEPT, 33_320, 3],
        [Q_INVALID, 33_317, 3],
        [Q_PROVIDER, 33_313, 3],
        [Q_RARE, 1, 2],
      ];
      for (const [q, n, days] of rows) {
        for (let back = 0; back < days; back++) {
          await c.query(
            `INSERT INTO search_query_day (day, query_norm, searches)
             VALUES ((now() AT TIME ZONE 'Europe/Istanbul')::date - $3::int, $1, $2)`,
            [q, n, back],
          );
        }
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM search_query_day WHERE query_norm LIKE $1", [`%qi${S}%`]);
      await c.query("DELETE FROM query_interpretation WHERE model_version = ANY($1)", [
        [MODEL, MODEL_2],
      ]);
      await c.query("DELETE FROM api_usage WHERE model_version = ANY($1)", [[MODEL, MODEL_2]]);
      await c.query("DELETE FROM job_run WHERE job = $1 AND id > $2", [
        QUERY_INTERPRETATION_JOB,
        jobCursor,
      ]);
    });
  });

  it("kabul edilen yorum saklanir, gecersiz guvenle kaydedilir, saglayici hatasi satir uretmez", async () => {
    const { client, inputs } = fakeClient(MODEL);
    const result = await runQueryInterpretationBatch(db, client, {
      registry: REGISTRY,
      maxQueries: 3,
    });

    expect(result).toMatchObject({
      status: "partial",
      attempted: 3,
      accepted: 1,
      invalid: 1,
      empty: 0,
      providerErrors: 1,
      providerCalls: 4,
    });
    expect(result.ineligible).toBeGreaterThanOrEqual(3);
    expect(result.deterministic).toBeGreaterThanOrEqual(1);

    const hash = interpreterContractHash(REGISTRY);
    const rows = await cacheRows(MODEL);
    expect(rows.map((r) => r.query_norm)).toEqual([Q_ACCEPT, Q_INVALID].sort());
    const accepted = rows.find((r) => r.query_norm === Q_ACCEPT);
    expect(accepted).toMatchObject({
      taxonomy_hash: hash,
      status: "accepted",
      interpretation: {
        domainId: "helmet",
        facets: [{ facetId: "helmet_type", optionId: "full_face" }],
        budget: null,
        pricePreference: null,
      },
      rejected: [],
    });
    const invalid = rows.find((r) => r.query_norm === Q_INVALID);
    expect(invalid).toMatchObject({
      status: "invalid",
      interpretation: null,
      rejected: [{ path: "domain_id", reason: "unknown_domain" }],
    });

    // Modele yalnizca sorgu, bos durum ve taksonomi gitti; kisisel/ham olay verisi yok.
    expect(inputs).toHaveLength(3);
    for (const input of inputs as Record<string, unknown>[]) {
      expect(Object.keys(input).sort()).toEqual(["current", "query", "taxonomy"]);
      expect(OURS).toContain(input.query);
      expect(input.current).toEqual({ domain_id: null, facets: [] });
      const serialized = JSON.stringify(input);
      for (const field of ["user_id", "session_id", "userId", "sessionId", "ip", "searches"]) {
        expect(serialized).not.toContain(`"${field}"`);
      }
    }
    // Uygunsuz, deterministik ve esik alti sorgular modele HIC gitmedi.
    const sent = (inputs as { query: string }[]).map((i) => i.query);
    for (const q of [Q_EMAIL, Q_SECRET, Q_SENSITIVE, Q_DOMAIN, Q_RARE, Q_ONE_DAY]) {
      expect(sent).not.toContain(q);
    }
  });

  it("farkli gun esigi SQL'de uygulanir: tek gunluk yogun sorgu aday bile olmaz", async () => {
    const selection = await selectInterpretationCandidates(db, {
      taxonomyHash: interpreterContractHash(registryVariant(`qi-sel-${S}`)),
      modelVersion: `${MODEL}-sel`,
      registry: REGISTRY,
      lexicon: [],
      limit: 20,
      now: new Date(),
    });
    expect(selection.candidates).not.toContain(Q_ONE_DAY);
    expect(selection.candidates).not.toContain(Q_RARE);
    expect(selection.candidates).not.toContain(Q_SENSITIVE);
    expect(selection.candidates).toEqual(expect.arrayContaining([Q_ACCEPT, Q_INVALID, Q_PROVIDER]));
  });

  it("her gercek saglayici cagrisi icin tam bir api_usage satiri; kimlik NULL, sorgu metni yok", async () => {
    const rows = await usageRows(MODEL);
    // kabul (1) + gecersiz (1, dogrulama basarisiz olsa da) + saglayici hatasi (2 deneme)
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        operation: QUERY_INTERPRETATION_OPERATION,
        model_version: MODEL,
        cache_hit: false,
        user_id: null,
        session_id: null,
      });
      expect(Number(row.cost_micros)).toBe(0);
    }
    expect(rows.map((r) => r.units).sort()).toEqual([0, 0, 103, 103]);
    expect(JSON.stringify(rows)).not.toContain(`qi${S}`);
  });

  it("islenmis sorgu atlanir; saglayici hatasi bir sonraki kosuda yeniden denenir", async () => {
    const { client, inputs } = fakeClient(MODEL);
    const result = await runQueryInterpretationBatch(db, client, {
      registry: REGISTRY,
      maxQueries: 1,
    });
    expect(inputs.map((i) => (i as { query: string }).query)).toEqual([Q_PROVIDER]);
    expect(result).toMatchObject({ attempted: 1, providerErrors: 1, status: "failed" });
    expect((await cacheRows(MODEL)).map((r) => r.query_norm)).toEqual([Q_ACCEPT, Q_INVALID].sort());
  });

  it("taksonomi ozeti degisince ayni model icin yeniden islenir", async () => {
    const { client, inputs } = fakeClient(MODEL);
    await runQueryInterpretationBatch(db, client, { registry: REGISTRY_2, maxQueries: 2 });
    expect(inputs.map((i) => (i as { query: string }).query)).toEqual([Q_ACCEPT, Q_INVALID]);
    const hashes = new Set(
      (await cacheRows(MODEL)).filter((r) => r.query_norm === Q_ACCEPT).map((r) => r.taxonomy_hash),
    );
    expect(hashes).toEqual(
      new Set([interpreterContractHash(REGISTRY), interpreterContractHash(REGISTRY_2)]),
    );
  });

  it("model surumu degisince yeniden islenir", async () => {
    const { client, inputs } = fakeClient(MODEL_2);
    await runQueryInterpretationBatch(db, client, { registry: REGISTRY, maxQueries: 2 });
    expect(inputs.map((i) => (i as { query: string }).query)).toEqual([Q_ACCEPT, Q_INVALID]);
    expect((await cacheRows(MODEL_2)).map((r) => r.query_norm)).toEqual(
      [Q_ACCEPT, Q_INVALID].sort(),
    );
  });

  it("kimlik benzersiz: ayni sorgu + ozet + model ikinci kez yazilamaz", async () => {
    const hash = interpreterContractHash(REGISTRY);
    const error = await withOwnerClient((c) =>
      c
        .query(
          `INSERT INTO query_interpretation (query_norm, taxonomy_hash, model_version, status)
           VALUES ($1, $2, $3, 'empty')`,
          [Q_ACCEPT, hash, MODEL],
        )
        .then(
          () => null,
          (e: { code?: string }) => e,
        ),
    );
    expect(error?.code).toBe("23505");
  });

  it("kosu tavani uygulanir (istenen 20'yi asamaz)", async () => {
    const { client, inputs } = fakeClient(`${MODEL}-cap`);
    const result = await runQueryInterpretationBatch(db, client, {
      registry: REGISTRY,
      maxQueries: 500,
    });
    expect(inputs.length).toBeLessThanOrEqual(20);
    expect(result.attempted).toBeLessThanOrEqual(20);
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM query_interpretation WHERE model_version = $1", [`${MODEL}-cap`]);
      await c.query("DELETE FROM api_usage WHERE model_version = $1", [`${MODEL}-cap`]);
    });
  });

  it("saglayici cagrisi yoksa api_usage satiri da yok (istemci yok / hepsi onbellekte)", async () => {
    const before = (await usageRows(MODEL)).length;
    const skipped = await runQueryInterpretationBatch(db, null);
    expect(skipped).toMatchObject({ status: "skipped", providerCalls: 0 });

    // REGISTRY + MODEL_2 icin iki sorgu da saklandi; saglayici hatasi verenden
    // baska aday kalmadigi icin limit 0 ile hicbir cagri yapilmaz.
    const { client, inputs } = fakeClient(MODEL);
    const none = await runQueryInterpretationBatch(db, client, {
      registry: REGISTRY,
      maxQueries: 0,
    });
    expect(none.providerCalls).toBe(0);
    expect(inputs).toHaveLength(0);
    expect((await usageRows(MODEL)).length).toBe(before);
  });

  describe("gunluk saglayici deneme tavani", () => {
    it("tavan 100; bugunku sayim yalnizca yorum denemelerini sayar", async () => {
      expect(QUERY_INTERPRETATION_DAILY_CALL_CAP).toBe(100);
      const before = await providerCallsToday(db, new Date());
      expect(before).toBeGreaterThanOrEqual(0);
    });

    it("tavan dolmussa saglayici cagrilmadan atlanir (skipped/daily_cap)", async () => {
      const used = await providerCallsToday(db, new Date());
      const { client, inputs } = fakeClient(MODEL);
      const result = await runQueryInterpretationBatch(db, client, {
        registry: registryVariant(`qi-cap1-${S}`),
        dailyCallCap: used + 1,
      });
      expect(result).toMatchObject({
        status: "skipped",
        skippedReason: "daily_cap",
        attempted: 0,
        providerCalls: 0,
        providerCallsToday: used,
      });
      expect(inputs).toHaveLength(0);
    });

    it("tavan bir sorguya yetiyorsa bir sorgu islenir, kalan ertelenir (stop=daily_cap)", async () => {
      const used = await providerCallsToday(db, new Date());
      const { client, inputs } = fakeClient(MODEL);
      const registry = registryVariant(`qi-cap2-${S}`);
      const result = await runQueryInterpretationBatch(db, client, {
        registry,
        dailyCallCap: used + 2,
      });
      expect(result.attempted).toBe(1);
      expect(result.stopCode).toBe("daily_cap");
      expect(result.deferred).toBeGreaterThanOrEqual(1);
      expect(inputs).toHaveLength(1);
      expect(await providerCallsToday(db, new Date())).toBe(used + result.providerCalls);
      // Yanit alani bu kosunun denemelerini de icerir (kosu oncesi sayim degil).
      expect(result.providerCalls).toBeGreaterThan(0);
      expect(result.providerCallsToday).toBe(used + result.providerCalls);
      await withOwnerClient(async (c) => {
        await c.query("DELETE FROM query_interpretation WHERE taxonomy_hash = $1", [
          interpreterContractHash(registry),
        ]);
      });
    });

    it("tavan yukseltilemez: istenen deger 100 ile sinirlanir", async () => {
      const used = await providerCallsToday(db, new Date());
      const { client } = fakeClient(MODEL);
      const result = await runQueryInterpretationBatch(db, client, {
        registry: registryVariant(`qi-cap3-${S}`),
        dailyCallCap: 1_000_000,
        maxQueries: 0,
      });
      expect(result.status).toBe(used + 2 > 100 ? "skipped" : "success");
    });
  });

  describe("job_run", () => {
    it("partial / failed / success / skipped; ayrinti yalnizca sayi ve sabit kod", async () => {
      const since = await lastJobRunId();
      // partial: REGISTRY_3 ile uc sorgu, biri saglayici hatasi.
      const registry3 = registryVariant(`qi3-${S}`);
      await runQueryInterpretationJob(
        db,
        {},
        { client: fakeClient(MODEL).client, registry: registry3, maxQueries: 3 },
      );
      // failed: yalnizca saglayici hatasi kalan sorgu.
      await runQueryInterpretationJob(
        db,
        {},
        { client: fakeClient(MODEL).client, registry: registry3, maxQueries: 1 },
      );
      // success: aday kalmadi (limit 0).
      await runQueryInterpretationJob(
        db,
        {},
        { client: fakeClient(MODEL).client, registry: registry3, maxQueries: 0 },
      );
      // skipped: anahtar yok - env bos, istemci verilmedi.
      await runQueryInterpretationJob(db, {});

      const rows = await jobRows(since);
      expect(rows.map((r) => r.status)).toEqual(["partial", "failed", "success", "success"]);
      expect(rows[0]?.detail).toMatchObject({
        attempted: 3,
        accepted: 1,
        invalid: 1,
        providerErrors: 1,
        skipped: false,
      });
      expect(rows[1]?.detail).toMatchObject({ attempted: 1, providerErrors: 1, skipped: false });
      expect(rows[2]?.detail).toMatchObject({ attempted: 0, skipped: false });
      expect(rows[3]?.detail).toMatchObject({
        skipped: true,
        skippedReason: "missing_api_key",
        attempted: 0,
      });
      for (const row of rows) {
        for (const value of Object.values(row.detail)) {
          expect(["number", "boolean", "string"]).toContain(typeof value);
          if (typeof value === "string") expect(value).toMatch(/^[a-z_]{1,40}$/);
        }
        expect(JSON.stringify(row)).not.toContain(`qi${S}`);
      }
      await withOwnerClient(async (c) => {
        await c.query("DELETE FROM query_interpretation WHERE taxonomy_hash = $1", [
          interpreterContractHash(registry3),
        ]);
      });
    });

    it("esanli kosu varsa ikincisi saglayici cagirmadan atlanir", async () => {
      const since = await lastJobRunId();
      const running = await withOwnerClient(async (c) => {
        const r = await c.query(
          `INSERT INTO job_run (job, trigger) VALUES ($1, 'cron') RETURNING id`,
          [QUERY_INTERPRETATION_JOB],
        );
        return r.rows[0].id as string;
      });
      const { client, inputs } = fakeClient(MODEL);
      const result = await runQueryInterpretationJob(
        db,
        {},
        { client, registry: registryVariant(`qi4-${S}`) },
      );
      expect(result).toMatchObject({
        status: "skipped",
        skippedReason: "already_running",
        attempted: 0,
      });
      expect(inputs).toHaveLength(0);
      await withOwnerClient((c) => c.query("DELETE FROM job_run WHERE id = $1", [running]));
      const rows = await jobRows(since);
      expect(rows.at(-1)?.detail).toMatchObject({
        skipped: true,
        skippedReason: "already_running",
      });
    });
  });
});

describe("query_interpretation saklama (90 gun)", () => {
  let db: Database;
  const R = `qr${S}`;
  const RET_MODEL = `fake-ret-${S}`;
  const DAY = 24 * 60 * 60 * 1000;

  async function rows() {
    return withOwnerClient(async (c) => {
      const r = await c.query(
        "SELECT query_norm FROM query_interpretation WHERE model_version = $1 ORDER BY query_norm",
        [RET_MODEL],
      );
      return r.rows.map((row: { query_norm: string }) => row.query_norm);
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const insert = (q: string, ageDays: number) =>
        c.query(
          `INSERT INTO query_interpretation
             (query_norm, taxonomy_hash, model_version, status, created_at)
           VALUES ($1, $2, $3, 'empty', now() - make_interval(days => $4))`,
          [q, "a".repeat(64), RET_MODEL, ageDays],
        );
      await insert(`${R} eski`, QUERY_INTERPRETATION_RETENTION_DAYS + 5);
      await insert(`${R} sinirda`, QUERY_INTERPRETATION_RETENTION_DAYS - 1);
      await insert(`${R} yeni`, 1);
      await c.query(
        `INSERT INTO search_query_day (day, query_norm, searches)
         VALUES ((now() AT TIME ZONE 'Europe/Istanbul')::date - 100, $1, 5)`,
        [`${R} kaynak`],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM query_interpretation WHERE model_version = $1", [RET_MODEL]);
      await c.query("DELETE FROM search_query_day WHERE query_norm LIKE $1", [`${R} %`]);
    });
  });

  it("yalnizca suresi dolmus yorum silinir; diger yorumlar ve arama verisi kalir", async () => {
    expect(QUERY_INTERPRETATION_RETENTION_DAYS).toBe(90);
    await purgeExpiredQueryInterpretations(db, new Date());
    expect(await rows()).toEqual([`${R} sinirda`, `${R} yeni`].sort());
    const source = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int AS n FROM search_query_day WHERE query_norm = $1", [
        `${R} kaynak`,
      ]),
    );
    expect(source.rows[0].n).toBe(1);
  });

  it("deterministik: ayni 'simdi' ile ikinci kosu bir sey silmez; zaman ilerleyince siradaki silinir", async () => {
    await purgeExpiredQueryInterpretations(db, new Date());
    expect(await rows()).toEqual([`${R} sinirda`, `${R} yeni`].sort());
    await purgeExpiredQueryInterpretations(db, new Date(Date.now() + 2 * DAY));
    expect(await rows()).toEqual([`${R} yeni`]);
  });
});

describe("en az yetki (0046) - uygulama rolu", () => {
  /** WHERE false: satira dokunmaz, yetki yine de denetlenir. Hata kodu ya da null. */
  async function sqlState(statement: string): Promise<string | null> {
    const db = getTestDb();
    try {
      await db.execute(sql.raw(statement));
      return null;
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      return e.cause?.code ?? e.code ?? "error";
    } finally {
      await db.$client.end();
    }
  }

  it("api_usage silinemez; query_interpretation guncellenemez (42501)", async () => {
    expect(await sqlState("DELETE FROM api_usage WHERE false")).toBe("42501");
    expect(await sqlState("UPDATE query_interpretation SET status = status WHERE false")).toBe(
      "42501",
    );
  });

  it("korunan yetkiler: hesap silme UPDATE'i ve 90 gunluk saklama DELETE'i calisir", async () => {
    expect(await sqlState("UPDATE api_usage SET user_id = user_id WHERE false")).toBeNull();
    expect(await sqlState("DELETE FROM query_interpretation WHERE false")).toBeNull();
    expect(await sqlState("SELECT count(*) FROM api_usage WHERE false")).toBeNull();
    expect(await sqlState("SELECT 1 FROM query_interpretation WHERE false")).toBeNull();
  });
});
