/**
 * `resolveQuery` gizlilik kapisi - gercek Postgres. Engellenen sorgu
 * `query_resolution`'daki satiri okumaz, yeni satir yazmaz ve mevcut satirin
 * sayacini/zamanini degistirmez; normal sorgu onbellegi eskisi gibi kullanir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { normalizeQueryText } from "./normalize.ts";
import { parseQueryText } from "./parse-query.ts";
import { resolveQuery } from "./query-resolution.ts";
import { BLOCKED_QUERIES, NORMAL_QUERIES } from "./query-resolution-test-cases.ts";

interface CacheRow {
  parsed: unknown;
  hit_count: number;
  last_used_at: Date;
}

async function cacheRow(queryNorm: string): Promise<CacheRow | null> {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "SELECT parsed, hit_count, last_used_at FROM query_resolution WHERE query_norm = $1",
      [queryNorm],
    );
    return (res.rows[0] as CacheRow | undefined) ?? null;
  });
}

async function apiUsageCount(): Promise<number> {
  return withOwnerClient(async (client) => {
    const res = await client.query("SELECT count(*)::int AS n FROM api_usage");
    return res.rows[0].n as number;
  });
}

describe("resolveQuery gizlilik kapisi - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const plantedRaw = `Iletisim.Test-${suffix}@Example.com siyah elbise`;
  const plantedNorm = normalizeQueryText(plantedRaw);
  const plantedLastUsed = new Date("2020-01-01T00:00:00Z");
  /** Normal sorgulardan bu testten once var olmayanlar; yalnizca onlar silinir. */
  const createdNorms: string[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count, last_used_at)
         VALUES ($1, '{"planted": true}'::jsonb, 2, 5, $2)`,
        [plantedNorm, plantedLastUsed],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [
        [plantedNorm, ...createdNorms],
      ]);
    });
  });

  it("engellenen sorgu mevcut satiri okumaz ve guncellemez", async () => {
    const lexicon = await loadLexicon(db);
    const result = await resolveQuery(db, plantedRaw);

    expect(result.cacheHit).toBe(false);
    expect(result.parsed).toEqual(parseQueryText(plantedRaw, lexicon));
    expect(result.parsed).not.toEqual({ planted: true });

    const row = await cacheRow(plantedNorm);
    expect(row?.parsed).toEqual({ planted: true });
    expect(row?.hit_count).toBe(5);
    expect(row?.last_used_at.toISOString()).toBe(plantedLastUsed.toISOString());
  });

  it("engellenen sorgular satir yazmaz, deterministik sonuc alir, model cagirmaz", async () => {
    const lexicon = await loadLexicon(db);
    const usageBefore = await apiUsageCount();

    for (const { raw } of BLOCKED_QUERIES) {
      const queryNorm = normalizeQueryText(raw);
      const before = await cacheRow(queryNorm);

      const result = await resolveQuery(db, raw);

      expect(result).toEqual({
        parsed: parseQueryText(raw, lexicon),
        parserTier: 2,
        needsClarification: false,
        candidateCategories: null,
        cacheHit: false,
      });
      expect(await cacheRow(queryNorm)).toEqual(before);
    }

    expect(await apiUsageCount()).toBe(usageBefore);
  });

  it("normal sorgular onbellege yazilir ve ikinci kez onbellekten okunur", async () => {
    const lexicon = await loadLexicon(db);
    for (const raw of NORMAL_QUERIES) {
      const queryNorm = normalizeQueryText(raw);
      const before = await cacheRow(queryNorm);
      if (!before) createdNorms.push(queryNorm);

      const first = await resolveQuery(db, raw);
      expect(first.cacheHit).toBe(before !== null);
      if (!before) expect(first.parsed).toEqual(parseQueryText(raw, lexicon));

      const second = await resolveQuery(db, raw);
      expect(second.cacheHit).toBe(true);
      expect(second.parsed).toEqual(first.parsed);

      const after = await cacheRow(queryNorm);
      expect(after?.hit_count).toBe((before?.hit_count ?? 0) + 2);
    }
  });
});
