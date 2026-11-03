/**
 * `query_resolution` - sozluk okuma hatasi ve okuma sayisi (docs/decisions/0171 §6.4),
 * gercek Postgres. `loadLexicon` sarmalanir: hata enjekte edilir ve cagrilar sayilir.
 *
 * Beklenen guvenli davranis:
 * - Damgasi bugunku kod surumune ait satir, sozluk okunamazsa da sunulur
 *   (#267 oncesi gibi isabet yolu sozluge bagli kalmaz).
 * - Damgasiz / baska kod surumlu satir ve kayit-yok yolu hata verir; satir
 *   bozulmaz, yeni satir yazilmaz.
 * - Bayat satir yeniden ayristirilirken sozluk YALNIZCA BIR KEZ okunur.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
import { invalidateLexiconCache, loadLexiconCached } from "./lexicon-cache.ts";
import { normalizeQueryText } from "./normalize.ts";
import { resolveQuery } from "./query-resolution.ts";

const control = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock("./lexicon-repository.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lexicon-repository.ts")>();
  return {
    ...original,
    loadLexicon: async (db: Parameters<typeof original.loadLexicon>[0]) => {
      control.calls += 1;
      if (control.fail) {
        throw Object.assign(new Error("lexicon read failed (test)"), { code: "57014" });
      }
      return original.loadLexicon(db);
    },
  };
});

const suffix = Array.from({ length: 10 }, () =>
  String.fromCharCode(97 + Math.floor(Math.random() * 26)),
).join("");
const norms: string[] = [];

function q(name: string): string {
  const text = `sozlukhata ${name} ${suffix} canta`;
  const norm = normalizeQueryText(text);
  expect(queryContentIneligibility(norm), text).toBeNull();
  norms.push(norm);
  return text;
}

async function row(text: string) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "SELECT parsed, hit_count FROM query_resolution WHERE query_norm = $1",
      [normalizeQueryText(text)],
    );
    return (res.rows[0] as { parsed: Record<string, unknown>; hit_count: number }) ?? null;
  });
}

async function plant(text: string, parsed: Record<string, unknown>) {
  await withOwnerClient((client) =>
    client.query(
      `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count)
       VALUES ($1, $2::jsonb, 2, 1)`,
      [normalizeQueryText(text), JSON.stringify(parsed)],
    ),
  );
}

describe("query_resolution sozluk hatasi ve okuma sayisi (gercek Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    control.fail = false;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await withOwnerClient((client) =>
      client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [norms]),
    );
    invalidateLexiconCache(db);
  });

  it("guncel damgali satir: sozluk okunamazsa da sunulur, arama kesilmez", async () => {
    const text = q("guncel");
    const fresh = await resolveQuery(db, text);
    invalidateLexiconCache(db); // onbellek bos: okuma DB'ye gitmek zorunda
    control.fail = true;
    const hit = await resolveQuery(db, text);
    expect(hit.cacheHit).toBe(true);
    expect(hit.parsed).toEqual(fresh.parsed);
    expect(console.warn).toHaveBeenCalled();
    // Uyari sorgu metni tasimaz (kisisel veri).
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain(suffix);
  });

  it("damgasiz satir: hata yukari iletilir, satir bozulmaz", async () => {
    const text = q("damgasiz");
    await plant(text, { planted: "legacy" });
    invalidateLexiconCache(db);
    control.fail = true;
    await expect(resolveQuery(db, text)).rejects.toThrow("lexicon read failed");
    const after = await row(text);
    expect(after?.parsed).toEqual({ planted: "legacy" });
    // Duzelince normal yola doner.
    control.fail = false;
    const recovered = await resolveQuery(db, text);
    expect(recovered.parsed).not.toHaveProperty("planted");
    expect((await resolveQuery(db, text)).cacheHit).toBe(true);
  });

  it("baska kod surumlu satir sozluk okunamazsa sunulmaz", async () => {
    const text = q("eskikod");
    await plant(text, { planted: "old-code", _resolver: "0:abc" });
    invalidateLexiconCache(db);
    control.fail = true;
    await expect(resolveQuery(db, text)).rejects.toThrow("lexicon read failed");
    expect((await row(text))?.parsed).toEqual({ planted: "old-code", _resolver: "0:abc" });
  });

  it("kayit-yok yolu: hata verir ve satir yazmaz (bugunku davranis)", async () => {
    const text = q("yok");
    invalidateLexiconCache(db);
    control.fail = true;
    await expect(resolveQuery(db, text)).rejects.toThrow("lexicon read failed");
    expect(await row(text)).toBeNull();
  });

  it("bayat (farkli sozluk ozetli) satir yeniden ayristirilirken sozluk tek kez okunur", async () => {
    const text = q("tekokuma");
    await plant(text, { planted: "stale", _resolver: "1:0000000000000000" });
    invalidateLexiconCache(db);
    await loadLexiconCached(db); // surec onbellegi dolu (istek yolundaki gibi)
    control.calls = 0;
    const result = await resolveQuery(db, text);
    expect(result.cacheHit).toBe(false);
    expect(result.parsed).not.toHaveProperty("planted");
    // Onbellek uyusmadi -> bir taze okuma; ayni sozluk ayristirmada yeniden kullanildi.
    expect(control.calls).toBe(1);
  });

  it("guncel isabet sozlugu DB'den okumaz (onbellek doluyken)", async () => {
    const text = q("isabet");
    await resolveQuery(db, text);
    await loadLexiconCached(db);
    control.calls = 0;
    expect((await resolveQuery(db, text)).cacheHit).toBe(true);
    expect(control.calls).toBe(0);
  });
});
