/**
 * `api_usage` maliyet telemetrisi, gercek Postgres ile (0059 + karar 0082):
 * anlik yorum, toplu yorum ve sohbet yollari saglayicinin bildirdigi
 * girdi/cikti tokenini ve surumlu fiyat kuraliyla tahmini TRY maliyetini
 * yazar; bildirilmeyen kullanim uydurulmaz. Saglayici butcesi (Redis) test
 * kancasiyla her zaman izin verir: muhasebe paylasilan gunluk tavana bagli degil.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatInterpreter } from "../chat/interpreter.ts";
import { createConversation, processPendingTurn } from "../chat/service.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import type { ProviderBudgetHooks } from "../quota/provider-budget.ts";
import { persistOutcome } from "../search/query-interpretation.ts";
import { resolveRealtimeInterpretation } from "../search/realtime-interpretation.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { LlmCallOptions, LlmClient, LlmJsonRequest, LlmUsage } from "./client.ts";
import { LlmError } from "./client.ts";
import { GEMINI_MODEL } from "./model.ts";
import { LLM_COST_FX_ENV } from "./pricing.ts";

// Rakamsiz: rakam dizisi sorguyu kisisel veri suzgecine (karar 0089, 0062)
// takar ve model hic cagrilmaz; isaret yalnizca harf olmali.
const RUN = randomUUID()
  .slice(0, 8)
  .replace(/\d/g, (d) => "ghijklmnop"[Number(d)] ?? "x");
const USAGE: LlmUsage = {
  inputTokens: 1000,
  outputTokens: 200,
  thoughtTokens: 50,
  totalTokens: 1250,
};
/** 1000 girdi + 250 faturalanan cikti, kur 40: (250 + 375) USD-mikro * 40. */
const EXPECTED_COST = 25_000;

/** Her zaman izin veren butce; kesinlestirme hicbir sey yapmaz. */
const OPEN_BUDGET: ProviderBudgetHooks = {
  reserve: async ({ operation, amount }) => ({
    allowed: true,
    reservation: { operation, key: `test:${operation}`, ttlSeconds: 60, reserved: amount },
  }),
  settle: async () => {},
};

interface Row {
  operation: string;
  user_id: string | null;
  units: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string;
}

let db: Database;
let userId = 0;

async function maxId(): Promise<number> {
  return withOwnerClient(async (c) =>
    Number((await c.query("SELECT coalesce(max(id), 0) AS id FROM api_usage")).rows[0].id),
  );
}

async function rowsAfter(id: number): Promise<Row[]> {
  return withOwnerClient(
    async (c) =>
      (
        await c.query(
          `SELECT operation, user_id, units, input_tokens, output_tokens, cost_micros
             FROM api_usage WHERE id > $1 ORDER BY id`,
          [id],
        )
      ).rows as Row[],
  );
}

function geminiClient(
  reply: () => { kind: "value"; value: unknown } | { kind: "error"; error: LlmError },
): LlmClient {
  return {
    modelVersion: GEMINI_MODEL,
    async generateJson(_request: LlmJsonRequest, options?: LlmCallOptions) {
      const r = reply();
      if (r.kind === "error") {
        options?.onCall?.({ modelVersion: GEMINI_MODEL, httpStatus: 503, usage: null });
        throw r.error;
      }
      options?.onCall?.({ modelVersion: GEMINI_MODEL, httpStatus: 200, usage: USAGE });
      return { value: r.value, usage: USAGE, modelVersion: GEMINI_MODEL };
    },
  };
}

const helmetFullFace = {
  domain_id: "helmet",
  facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
  budget: null,
  price_preference: null,
};

beforeAll(async () => {
  db = getTestDb();
  vi.stubEnv(LLM_COST_FX_ENV, "40");
  userId = await withOwnerClient(async (c) =>
    Number(
      (
        await c.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
          `usage-accounting-${RUN}@test.invalid`,
        ])
      ).rows[0].id,
    ),
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await withOwnerClient(async (c) => {
    await c.query("DELETE FROM api_usage WHERE user_id = $1", [userId]);
    await c.query("DELETE FROM app_user WHERE id = $1", [userId]);
    await c.query("DELETE FROM query_interpretation WHERE query_norm LIKE $1", [`%${RUN}%`]);
  });
});

describe("anlik ve toplu yorum (persistOutcome)", () => {
  it("basarili anlik cagri: girdi, faturalanan cikti (dusunme dahil), toplam ve TRY maliyeti", async () => {
    const before = await maxId();
    const result = await resolveRealtimeInterpretation(db, `kask ${RUN} maliyet`, {
      client: geminiClient(() => ({ kind: "value", value: helmetFullFace })),
      registry: DEFAULT_CLARIFICATION_REGISTRY,
      budget: OPEN_BUDGET,
    });
    expect(result.source).toBe("realtime");
    expect(await rowsAfter(before)).toEqual([
      {
        operation: "query_interpretation_realtime",
        user_id: null,
        units: 1250,
        input_tokens: 1000,
        output_tokens: 250,
        cost_micros: String(EXPECTED_COST),
      },
    ]);
  });

  it("saglayici hatasi, kullanim bildirilmedi: satir yazilir, tokenler NULL, maliyet 0", async () => {
    const before = await maxId();
    const result = await resolveRealtimeInterpretation(db, `kask ${RUN} hata`, {
      client: geminiClient(() => ({ kind: "error", error: new LlmError("server_error", 503) })),
      registry: DEFAULT_CLARIFICATION_REGISTRY,
      budget: OPEN_BUDGET,
    });
    expect(result).toEqual({ source: "none", reason: "provider_error" });
    expect(await rowsAfter(before)).toEqual([
      {
        operation: "query_interpretation_realtime",
        user_id: null,
        units: 0,
        input_tokens: null,
        output_tokens: null,
        cost_micros: "0",
      },
    ]);
  });

  it("toplu is ayni yolu kullanir; islem adi korunur", async () => {
    const before = await maxId();
    await persistOutcome(db, {
      queryNorm: `kask ${RUN} toplu`,
      taxonomyHash: "test",
      outcome: {
        status: "provider_error",
        code: "timeout",
        calls: [{ modelVersion: GEMINI_MODEL, httpStatus: 200, usage: USAGE }],
        modelVersion: GEMINI_MODEL,
      },
    });
    const rows = await rowsAfter(before);
    expect(rows.map((r) => [r.operation, r.input_tokens, r.output_tokens, r.cost_micros])).toEqual([
      ["query_interpretation", 1000, 250, String(EXPECTED_COST)],
    ]);
  });
});

describe("sohbet", () => {
  /** Istemcinin kendi yeniden denemesini taklit eder: once hata (kullanim yok), sonra basari. */
  function interpreter(attempts: Array<"fail" | "ok">): ChatInterpreter {
    return {
      modelVersion: GEMINI_MODEL,
      async interpret(_request, opts) {
        for (const attempt of attempts) {
          if (attempt === "fail") {
            opts?.onCall?.({ modelVersion: GEMINI_MODEL, httpStatus: 503, usage: null });
          } else {
            opts?.onCall?.({ modelVersion: GEMINI_MODEL, httpStatus: 200, usage: USAGE });
          }
        }
        if (attempts.at(-1) === "fail") throw new LlmError("server_error", 503);
        return {
          value: { action: "search", intent: { query: `kask ${RUN}` } },
          usage: USAGE,
          modelVersion: GEMINI_MODEL,
        };
      },
    };
  }

  async function turn(attempts: Array<"fail" | "ok">): Promise<Row[]> {
    const created = await createConversation(db, { userId, message: `kask ${RUN} sohbet` });
    if (created.status !== "created") throw new Error(created.status);
    const before = await maxId();
    await processPendingTurn(db, {
      userId,
      conversationId: created.conversationId,
      interpreter: interpreter(attempts),
      budget: OPEN_BUDGET,
    });
    return rowsAfter(before);
  }

  it("basarili tur: tek satir, kullanicinin, tam token ve maliyet", async () => {
    const rows = await turn(["ok"]);
    expect(rows).toEqual([
      {
        operation: "chat_turn",
        user_id: String(userId),
        units: 1250,
        input_tokens: 1000,
        output_tokens: 250,
        cost_micros: String(EXPECTED_COST),
      },
    ]);
  });

  it("yeniden deneme: her deneme bir satir; kullanimsiz basarisiz deneme 0 maliyet, cift sayim yok", async () => {
    const rows = await turn(["fail", "ok"]);
    expect(rows.map((r) => [r.units, r.input_tokens, r.output_tokens, r.cost_micros])).toEqual([
      [0, null, null, "0"],
      [1250, 1000, 250, String(EXPECTED_COST)],
    ]);
    const total = rows.reduce((sum, r) => sum + Number(r.cost_micros), 0);
    expect(total).toBe(EXPECTED_COST);
  });

  it("tum denemeler basarisiz: satirlar yazilir, maliyet 0, istek yine sonuclanir", async () => {
    const rows = await turn(["fail", "fail"]);
    expect(rows.map((r) => [r.input_tokens, r.cost_micros])).toEqual([
      [null, "0"],
      [null, "0"],
    ]);
  });
});

describe("geriye uyumluluk", () => {
  it("yeni kolonlari bilmeyen yazar (embedding, Python) calismaya devam eder: NULL", async () => {
    const before = await maxId();
    await withOwnerClient((c) =>
      c.query(
        `INSERT INTO api_usage (session_id, user_id, operation, model_version, units, cost_micros, cache_hit)
         VALUES (NULL, $1, 'visual_search', 'jina-clip-v2', 4000, 0, FALSE)`,
        [userId],
      ),
    );
    expect(await rowsAfter(before)).toEqual([
      {
        operation: "visual_search",
        user_id: String(userId),
        units: 4000,
        input_tokens: null,
        output_tokens: null,
        cost_micros: "0",
      },
    ]);
  });
});
