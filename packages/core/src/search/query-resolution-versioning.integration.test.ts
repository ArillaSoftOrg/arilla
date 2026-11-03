/**
 * `query_resolution` surum damgasi (docs/decisions/0171 §6.4) - gercek Postgres.
 * Bayat ayristirma (eski kod ya da eski sozlukle uretilmis) yeniden kullanilmaz.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { invalidateLexiconCache } from "./lexicon-cache.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { normalizeQueryText } from "./normalize.ts";
import { peekQuery, resolveQuery, resolverVersion } from "./query-resolution.ts";

const suffix = Array.from({ length: 10 }, () =>
  String.fromCharCode(97 + Math.floor(Math.random() * 26)),
).join("");

async function storedParsed(queryNorm: string): Promise<Record<string, unknown> | null> {
  return withOwnerClient(async (client) => {
    const res = await client.query("SELECT parsed FROM query_resolution WHERE query_norm = $1", [
      queryNorm,
    ]);
    return (res.rows[0]?.parsed as Record<string, unknown> | undefined) ?? null;
  });
}

async function plant(queryNorm: string, parsed: Record<string, unknown>) {
  await withOwnerClient(async (client) => {
    await client.query(
      `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count)
       VALUES ($1, $2::jsonb, 2, 3)`,
      [queryNorm, JSON.stringify(parsed)],
    );
  });
}

describe("query_resolution surum damgasi (gercek Postgres)", () => {
  let db: Database;
  const legacy = `surum-eski-${suffix} canta`;
  const wrong = `surum-yanlis-${suffix} canta`;
  const current = `surum-guncel-${suffix} canta`;
  const lexiconQuery = `surum-sozluk-${suffix} canta`;
  const brandSurface = `markax${suffix}`;
  const norms = [legacy, wrong, current, lexiconQuery].map(normalizeQueryText);

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [norms]);
      await client.query("DELETE FROM lexicon WHERE surface = $1", [brandSurface]);
    });
    invalidateLexiconCache(db);
  });

  it("damgasiz (eski) satir okunmaz; yeniden ayristirilir ve damgalanir", async () => {
    const norm = normalizeQueryText(legacy);
    await plant(norm, { planted: "legacy" });
    const result = await resolveQuery(db, legacy);
    expect(result.cacheHit).toBe(false);
    expect(result.parsed).not.toHaveProperty("planted");
    const stored = await storedParsed(norm);
    expect(stored?._resolver).toBe(resolverVersion(await loadLexicon(db)));
    expect(stored).not.toHaveProperty("planted");
  });

  it("baska surumle damgali satir okunmaz", async () => {
    const norm = normalizeQueryText(wrong);
    await plant(norm, { planted: "wrong", _resolver: "0:eski" });
    expect((await peekQuery(db, wrong)).cacheHit).toBe(false);
    const result = await resolveQuery(db, wrong);
    expect(result.cacheHit).toBe(false);
    expect(result.parsed).not.toHaveProperty("planted");
  });

  it("guncel satir isabettir ve damga disari sizmaz", async () => {
    await resolveQuery(db, current);
    const second = await resolveQuery(db, current);
    expect(second.cacheHit).toBe(true);
    expect(second.parsed).not.toHaveProperty("_resolver");
  });

  it("sozluge panel disindan yazilinca eski ayristirma tasinmaz", async () => {
    const before = await resolveQuery(db, `${brandSurface} ${lexiconQuery}`);
    expect(before.parsed.filters.brand_include ?? []).not.toContain(brandSurface);

    // Toplu is gibi dogrudan yazim: onbellek temizlenmez.
    await withOwnerClient(async (client) => {
      await client.query(
        "INSERT INTO lexicon (kind, surface, normalized, weight) VALUES ('brand', $1, $1, 1)",
        [brandSurface],
      );
    });

    // Surec ici sozluk onbellegi en cok LEXICON_CACHE_TTL_MS bayat kalir; sure
    // dolmus gibi tazelenir. Sonrasinda eski ayristirma kullanilmaz.
    invalidateLexiconCache(db);
    const after = await resolveQuery(db, `${brandSurface} ${lexiconQuery}`);
    expect(after.cacheHit).toBe(false);
    expect(after.parsed.filters.brand_include).toContain(brandSurface);
    norms.push(normalizeQueryText(`${brandSurface} ${lexiconQuery}`));
  });
});
