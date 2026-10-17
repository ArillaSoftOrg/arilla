/**
 * `peekQuery` (salt okunur olcum araci, scripts/search-probe.ts) - gercek Postgres.
 * Onbellekteki satiri okur ama sayacini/zamanini degistirmez; olmayan sorgu icin satir YAZMAZ;
 * sonuc `resolveQuery`'nin ayristirmasiyla aynidir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { normalizeQueryText } from "./normalize.ts";
import { peekQuery, resolveQuery } from "./query-resolution.ts";

async function row(queryNorm: string) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "SELECT parsed, hit_count, last_used_at FROM query_resolution WHERE query_norm = $1",
      [queryNorm],
    );
    return (
      (res.rows[0] as { parsed: unknown; hit_count: number; last_used_at: Date } | undefined) ??
      null
    );
  });
}

describe("peekQuery - yazmayan sorgu ayristirma (gercek Postgres)", () => {
  let db: Database;
  // Yalniz harf: uzun rakam dizisi gizlilik kapisina takilir (telefon gibi) ve onbellek yolu sinanmaz.
  const suffix = Array.from({ length: 10 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
  const planted = `peek-planted-${suffix} siyah canta`;
  const plantedNorm = normalizeQueryText(planted);
  const fresh = `peek-fresh-${suffix} kirmizi elbise`;
  const freshNorm = normalizeQueryText(fresh);
  const lastUsed = new Date("2020-01-01T00:00:00Z");

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count, last_used_at)
         VALUES ($1, '{"planted": true}'::jsonb, 2, 5, $2)`,
        [plantedNorm, lastUsed],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [
        [plantedNorm, freshNorm],
      ]);
    });
  });

  it("onbellekteki satiri dondurur, sayaci ve zamani degistirmez", async () => {
    const result = await peekQuery(db, planted);
    expect(result.cacheHit).toBe(true);
    expect(result.parsed).toEqual({ planted: true });
    const after = await row(plantedNorm);
    expect(after?.hit_count).toBe(5);
    expect(after?.last_used_at.toISOString()).toBe(lastUsed.toISOString());
  });

  it("olmayan sorgu icin satir yazmaz ve resolveQuery ile ayni ayristirmayi verir", async () => {
    const peeked = await peekQuery(db, fresh);
    expect(peeked.cacheHit).toBe(false);
    expect(await row(freshNorm)).toBeNull();
    const resolved = await resolveQuery(db, fresh);
    expect(resolved.parsed).toEqual(peeked.parsed);
  });
});
