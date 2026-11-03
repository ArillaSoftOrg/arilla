/**
 * `query_resolution` surum damgasi (docs/decisions/0171 §6.4) - gercek Postgres.
 * Bayat ayristirma (eski kod ya da eski sozlukle uretilmis) yeniden kullanilmaz;
 * yeniden ayristirilan satir sonraki istekte isabettir; eski kod damgali satiri
 * okuyabilir (geri alma guvenli).
 *
 * Temizlik yalnizca bu dosyanin urettigi `query_norm`'lari ve lexicon satirini
 * siler; baglanti `test-db.ts` + `vitest-isolation-setup.ts` ile yalnizca yerel
 * (izole) veritabanina izinlidir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { searchWithFallback } from "./fallback/pipeline.ts";
import { createPostgresSearchProvider } from "./fallback/postgres-provider.ts";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
import { invalidateLexiconCache } from "./lexicon-cache.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { normalizeQueryText } from "./normalize.ts";
import {
  lexiconFingerprint,
  peekQuery,
  RESOLVER_VERSION,
  resolveQuery,
  resolverVersion,
} from "./query-resolution.ts";
import type { QueryObject } from "./types.ts";

const suffix = Array.from({ length: 10 }, () =>
  String.fromCharCode(97 + Math.floor(Math.random() * 26)),
).join("");

const norms: string[] = [];

/**
 * Yalniz harfli, gizlilik suzgecinden gecen sorgu. Rakam/harf karisik etiketler
 * suzgece takilir; o zaman onbellek yolu hic sinanmaz (sessiz yanlis yesil).
 */
function q(name: string): string {
  const text = `surum ${name} ${suffix} canta`;
  const norm = normalizeQueryText(text);
  expect(queryContentIneligibility(norm), text).toBeNull();
  norms.push(norm);
  return text;
}

async function stored(
  text: string,
): Promise<{ parsed: Record<string, unknown>; hit_count: number } | null> {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "SELECT parsed, hit_count FROM query_resolution WHERE query_norm = $1",
      [normalizeQueryText(text)],
    );
    return res.rows[0] ?? null;
  });
}

async function plant(text: string, parsed: Record<string, unknown>) {
  await withOwnerClient(async (client) => {
    await client.query(
      `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count)
       VALUES ($1, $2::jsonb, 2, 3)`,
      [normalizeQueryText(text), JSON.stringify(parsed)],
    );
  });
}

/** #267 oncesi okuyucu (`main` 4910bd80 `toResult`): `parsed` oldugu gibi, damga dahil. */
async function legacyRead(text: string): Promise<QueryObject | null> {
  const row = await stored(text);
  return row ? (row.parsed as unknown as QueryObject) : null;
}

describe("query_resolution surum damgasi (gercek Postgres)", () => {
  let db: Database;
  const brandSurface = `markax${suffix}`;

  beforeAll(() => {
    db = getTestDb();
    invalidateLexiconCache(db);
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [norms]);
      await client.query("DELETE FROM lexicon WHERE surface = $1", [brandSurface]);
    });
    invalidateLexiconCache(db);
  });

  it("eski (damgasiz) kayit -> yeniden ayristirma -> sonraki istek guncel isabet", async () => {
    const text = q("eski");
    await plant(text, { planted: "legacy" });

    const first = await resolveQuery(db, text);
    expect(first.cacheHit).toBe(false);
    expect(first.parsed).not.toHaveProperty("planted");
    const row = await stored(text);
    expect(row?.parsed._resolver).toBe(resolverVersion(await loadLexicon(db)));
    expect(row?.parsed).not.toHaveProperty("planted");
    expect(row?.hit_count).toBe(4); // sayac korunur ve artar

    const second = await resolveQuery(db, text);
    expect(second.cacheHit).toBe(true);
    expect(second.parsed).toEqual(first.parsed);
    expect(second.parsed).not.toHaveProperty("_resolver");
  });

  it("kod surumu degisince (RESOLVER_VERSION) satir yenilenir ve yeni damgayi alir", async () => {
    const text = q("kodsurumu");
    const fingerprint = lexiconFingerprint(await loadLexicon(db));
    // Ayni sozluk, eski kod surumu: yalniz kod degisti.
    await plant(text, { planted: "old-code", _resolver: `0:${fingerprint}` });

    expect((await peekQuery(db, text)).cacheHit).toBe(false);
    const refreshed = await resolveQuery(db, text);
    expect(refreshed.cacheHit).toBe(false);
    expect(refreshed.parsed).not.toHaveProperty("planted");
    expect((await stored(text))?.parsed._resolver).toBe(`${RESOLVER_VERSION}:${fingerprint}`);
    expect((await resolveQuery(db, text)).cacheHit).toBe(true);
  });

  it("guncel satir isabettir ve damga disari sizmaz", async () => {
    const text = q("guncel");
    await resolveQuery(db, text);
    const second = await resolveQuery(db, text);
    expect(second.cacheHit).toBe(true);
    expect(second.parsed).not.toHaveProperty("_resolver");
  });

  it("ayni bayat kayda 20 esz amanli istek: hata yok, ayni sonuc, tek damga, dogru sayac", async () => {
    const text = q("eszamanli");
    await plant(text, { planted: "legacy" });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => resolveQuery(db, text)),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const parsed = results.map((r) =>
      JSON.stringify((r as PromiseFulfilledResult<{ parsed: unknown }>).value.parsed),
    );
    expect(new Set(parsed).size).toBe(1);
    expect(parsed[0]).not.toContain("_resolver");
    expect(parsed[0]).not.toContain("planted");
    const row = await stored(text);
    expect(row?.hit_count).toBe(3 + 20);
    expect(row?.parsed._resolver).toBe(resolverVersion(await loadLexicon(db)));
    expect((await resolveQuery(db, text)).cacheHit).toBe(true);
  });

  it("ayni yeni sorguya 20 eszamanli istek: tek satir, ayni sonuc", async () => {
    const text = q("yenieszamanli");
    const results = await Promise.all(Array.from({ length: 20 }, () => resolveQuery(db, text)));
    expect(new Set(results.map((r) => JSON.stringify(r.parsed))).size).toBe(1);
    const row = await stored(text);
    expect(row?.hit_count).toBe(20);
    expect(typeof row?.parsed._resolver).toBe("string");
  });

  describe("geriye uyumluluk (geri alma)", () => {
    it("eski okuyucu damgali satiri okuyabilir; damga eklemelidir, alanlar aynidir", async () => {
      const text = q("geri");
      const fresh = await resolveQuery(db, text);
      const old = await legacyRead(text);
      expect(old).not.toBeNull();
      const { _resolver, ...rest } = old as unknown as Record<string, unknown>;
      expect(typeof _resolver).toBe("string");
      expect(rest).toEqual(fresh.parsed);
    });

    it("eski okuyucunun dondurdugu (damgali) nesne arama hattini bozmaz", async () => {
      const text = q("gerihat");
      const fresh = await resolveQuery(db, text);
      const old = (await legacyRead(text)) as QueryObject;
      const provider = createPostgresSearchProvider(db, { statementTimeoutMs: 5000 });
      const request = (parsed: QueryObject) => ({
        parsed: { ...parsed, sort: "balanced" as const },
        sort: "balanced" as const,
        page: 1,
        pageSize: 24,
      });
      const withStamp = await searchWithFallback(provider, request(old));
      const without = await searchWithFallback(provider, request(fresh.parsed));
      expect(withStamp.mode).toBe(without.mode);
      expect(withStamp.items.map((i) => i.productId)).toEqual(
        without.items.map((i) => i.productId),
      );
    });

    it("eski kodun yazdigi (damgasiz) satir bir kez yeniden ayristirilir, sonra isabet", async () => {
      const text = q("eskiyazar");
      // Eski yazici: `parsed` damgasiz QueryObject.
      const fresh = await peekQuery(db, text);
      await plant(text, fresh.parsed as unknown as Record<string, unknown>);
      const first = await resolveQuery(db, text);
      expect(first.cacheHit).toBe(false);
      expect(first.parsed).toEqual(fresh.parsed);
      expect((await resolveQuery(db, text)).cacheHit).toBe(true);
    });
  });

  it("sozluge panel disindan yazilinca eski ayristirma tasinmaz", async () => {
    const text = q("sozluk");
    const query = `${brandSurface} ${text}`;
    norms.push(normalizeQueryText(query));
    const before = await resolveQuery(db, query);
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
    const after = await resolveQuery(db, query);
    expect(after.cacheHit).toBe(false);
    expect(after.parsed.filters.brand_include).toContain(brandSurface);
    expect((await resolveQuery(db, query)).cacheHit).toBe(true);
  });
});
