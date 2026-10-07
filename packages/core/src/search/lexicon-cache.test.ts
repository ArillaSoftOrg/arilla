import type { Database } from "@arilla/db";
import { describe, expect, it, vi } from "vitest";
import type { LexiconEntry } from "./lexicon.ts";
import {
  invalidateLexiconCache,
  LEXICON_CACHE_TTL_MS,
  loadLexiconCached,
} from "./lexicon-cache.ts";

const entry = (surface: string): LexiconEntry => ({
  kind: "color",
  surface,
  normalized: surface,
  weight: 1,
});
const makeDb = () => ({}) as Database;

describe("loadLexiconCached", () => {
  it("TTL icinde DB'ye tekrar gitmez, sonra tazeler", async () => {
    const db = makeDb();
    let now = 1_000;
    const load = vi.fn(async () => [entry(`v${load.mock.calls.length}`)]);
    const first = await loadLexiconCached(db, () => now, load);
    now += LEXICON_CACHE_TTL_MS - 1;
    expect(await loadLexiconCached(db, () => now, load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    now += 2;
    const refreshed = await loadLexiconCached(db, () => now, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(first);
  });

  it("es zamanli istekler tek okumayi paylasir", async () => {
    const db = makeDb();
    const load = vi.fn(async () => [entry("a")]);
    await Promise.all([1, 2, 3].map(() => loadLexiconCached(db, () => 0, load)));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("hata onbellege yazilmaz; sonraki cagri yeniden dener", async () => {
    const db = makeDb();
    const load = vi
      .fn<() => Promise<LexiconEntry[]>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([entry("a")]);
    await expect(loadLexiconCached(db, () => 0, load)).rejects.toThrow("down");
    expect(await loadLexiconCached(db, () => 0, load)).toEqual([entry("a")]);
  });

  it("invalidate aninda tazeletir; veritabanlari birbirini kirletmez", async () => {
    const [a, b] = [makeDb(), makeDb()];
    const load = vi.fn(async () => [entry("x")]);
    await loadLexiconCached(a, () => 0, load);
    await loadLexiconCached(b, () => 0, load);
    expect(load).toHaveBeenCalledTimes(2);
    invalidateLexiconCache(a);
    await loadLexiconCached(a, () => 0, load);
    await loadLexiconCached(b, () => 0, load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
