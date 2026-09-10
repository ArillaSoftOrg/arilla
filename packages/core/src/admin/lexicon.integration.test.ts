import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listLexicon, recentTier3Queries, upsertLexiconEntry } from "./lexicon.ts";

describe("sözlük yönetimi - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const surface = `admin-lexicon-test-yuzey-${suffix}`;
  const cacheProbeQueryNorm = `admin-lexicon-test-cache-probe-${suffix}`;
  const tier3QueryNorm = `admin-lexicon-test-tier3-${suffix}`;
  const tier2QueryNorm = `admin-lexicon-test-tier2-${suffix}`;
  let insertedId = 0;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM lexicon WHERE surface = $1", [surface]);
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [
        [cacheProbeQueryNorm, tier3QueryNorm, tier2QueryNorm],
      ]);
    });
  });

  it("upsertLexiconEntry: id verilmeden ekler, sonra id ile günceller", async () => {
    await upsertLexiconEntry(db, {
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/once",
      weight: 0.5,
    });

    const afterInsert = await listLexicon(db, { search: surface });
    expect(afterInsert).toHaveLength(1);
    expect(afterInsert[0]?.normalized).toBe("admin-lexicon-test/once");
    insertedId = afterInsert[0]!.id;

    await upsertLexiconEntry(db, {
      id: insertedId,
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/sonra",
      weight: 0.9,
    });

    const afterUpdate = await listLexicon(db, { kind: "category", search: surface });
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]?.id).toBe(insertedId);
    expect(afterUpdate[0]?.normalized).toBe("admin-lexicon-test/sonra");
    expect(afterUpdate[0]?.weight).toBeCloseTo(0.9);
  });

  it("upsertLexiconEntry: aynı (kind, surface) ile id vermeden çağrılırsa çakışan satırı günceller", async () => {
    await upsertLexiconEntry(db, {
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/cakisma",
      weight: 0.7,
    });

    const rows = await listLexicon(db, { search: surface });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(insertedId);
    expect(rows[0]?.normalized).toBe("admin-lexicon-test/cakisma");
  });

  it("listLexicon: kind eşleşmeyince boş döner", async () => {
    const rows = await listLexicon(db, { kind: "brand", search: surface });
    expect(rows).toHaveLength(0);
  });

  it("upsertLexiconEntry: query_resolution önbelleğini temizler (docs/pages.md: 'aramayı anında etkiliyor')", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier)
         VALUES ($1, '{}'::jsonb, 2)`,
        [cacheProbeQueryNorm],
      );
    });

    const beforeUpsert = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT 1 FROM query_resolution WHERE query_norm = $1", [
        cacheProbeQueryNorm,
      ]);
      return res.rowCount;
    });
    expect(beforeUpsert).toBe(1);

    await upsertLexiconEntry(db, {
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/cache-tetikleyici",
      weight: 0.6,
    });

    const afterUpsert = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT 1 FROM query_resolution WHERE query_norm = $1", [
        cacheProbeQueryNorm,
      ]);
      return res.rowCount;
    });
    expect(afterUpsert).toBe(0);
  });

  it("recentTier3Queries: yalnızca parser_tier=3 ve son 7 gün içindeki satırları döner", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count, last_used_at)
         VALUES ($1, '{}'::jsonb, 3, 4, now())`,
        [tier3QueryNorm],
      );
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count, last_used_at)
         VALUES ($1, '{}'::jsonb, 2, 9, now())`,
        [tier2QueryNorm],
      );
    });

    const rows = await recentTier3Queries(db, 100);
    expect(rows.some((row) => row.queryNorm === tier3QueryNorm)).toBe(true);
    expect(rows.some((row) => row.queryNorm === tier2QueryNorm)).toBe(false);
  });
});
