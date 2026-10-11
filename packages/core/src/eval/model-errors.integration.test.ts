/**
 * Karar 0099: sorgu yorumu yolunda (`persistOutcome`) Gemini hata kaydi -
 * gercek (yalitilmis) Postgres. Testler yalnizca kendi `t99_` operasyon adini
 * yazar ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelInterpretationOutcome } from "../llm/intent-interpreter.ts";
import { persistOutcome } from "../search/query-interpretation.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";

const SUFFIX = Date.now().toString(36).slice(-6);
const OP = `t99_op_${SUFFIX}`;
const call = (httpStatus: number | null) => ({
  modelVersion: "gemini-t99",
  httpStatus,
  usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 },
});

async function events() {
  return withOwnerClient(
    async (c) =>
      (
        await c.query<{
          error_class: string;
          http_status: number | null;
          api_usage_id: string | null;
          surface: string;
          error_summary: string | null;
        }>(
          "SELECT error_class, http_status, api_usage_id, surface, error_summary FROM ai_error_event WHERE operation = $1 ORDER BY id",
          [OP],
        )
      ).rows,
  );
}

describe("persistOutcome -> ai_error_event", () => {
  let db: Database;
  let n = 0;
  const run = (outcome: ModelInterpretationOutcome) =>
    persistOutcome(db, {
      queryNorm: `t99-${SUFFIX}-${n++}`,
      taxonomyHash: "a".repeat(64),
      outcome,
      operation: OP,
    });

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM ai_error_event WHERE operation = $1", [OP]);
      await c.query("DELETE FROM api_usage WHERE operation = $1", [OP]);
      await c.query("DELETE FROM query_interpretation WHERE query_norm LIKE $1", [
        `t99-${SUFFIX}-%`,
      ]);
    });
  });

  it("basarili cagri hata olayi yazmaz", async () => {
    await run({
      status: "empty",
      rejected: [],
      calls: [call(200)],
      modelVersion: "gemini-t99",
    });
    expect(await events()).toHaveLength(0);
  });

  it("rate limit: yeniden denemeler dahil TEK olay, son denemenin durumu, api_usage'a bagli", async () => {
    await run({
      status: "provider_error",
      code: "rate_limited",
      calls: [call(429), call(429), call(429)],
      modelVersion: "gemini-t99",
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      error_class: "rate_limited",
      http_status: 429,
      surface: "search",
    });
    expect(rows[0]?.api_usage_id).not.toBeNull();
  });

  it("timeout, gecersiz JSON ve dogrulama hatasi ayri siniflarla yazilir", async () => {
    await run({
      status: "provider_error",
      code: "timeout",
      calls: [{ ...call(null), usage: null }],
      modelVersion: "gemini-t99",
    });
    await run({
      status: "invalid",
      rejected: [{ path: "$", reason: "invalid_json" }],
      calls: [call(200)],
      modelVersion: "gemini-t99",
    });
    await run({
      status: "invalid",
      rejected: [{ path: "$.facets[0]", reason: "unknown_facet" }],
      calls: [call(200)],
      modelVersion: "gemini-t99",
    } as ModelInterpretationOutcome);
    const classes = (await events()).map((r) => r.error_class);
    expect(classes).toEqual(["rate_limited", "timeout", "schema_invalid", "schema_invalid"]);
  });

  it("ozet icerik/kimlik tasimaz", async () => {
    for (const row of await events()) {
      expect(row.error_summary ?? "").not.toMatch(/t99-|@/i);
    }
  });
});
