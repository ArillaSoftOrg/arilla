import type { Database } from "@arilla/db";
import { describe, expect, it, vi } from "vitest";
import { buildVocabulary } from "./vocabulary.ts";
import {
  invalidateVocabularyCache,
  loadVocabularyCached,
  VOCABULARY_CACHE_TTL_MS,
} from "./vocabulary-repository.ts";

const makeDb = () => ({}) as Database;
const vocabulary = (brand: string) =>
  buildVocabulary({ categories: ["Kılıf"], lexicon: [], brands: [brand] });

describe("loadVocabularyCached", () => {
  it("reuses the vocabulary within the TTL and refreshes after it", async () => {
    const db = makeDb();
    let now = 1_000;
    const load = vi.fn(async () => vocabulary(load.mock.calls.length === 1 ? "Birinci" : "Ikinci"));
    const first = await loadVocabularyCached(db, () => now, load);
    now += VOCABULARY_CACHE_TTL_MS - 1;
    expect(await loadVocabularyCached(db, () => now, load)).toBe(first);
    now += 2;
    const refreshed = await loadVocabularyCached(db, () => now, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(refreshed.version).not.toBe(first.version);
  });

  it("shares one load between concurrent callers and does not cache errors", async () => {
    const db = makeDb();
    const load = vi.fn(async () => vocabulary("a"));
    await Promise.all([1, 2, 3].map(() => loadVocabularyCached(db, () => 0, load)));
    expect(load).toHaveBeenCalledTimes(1);

    const failing = makeDb();
    const flaky = vi
      .fn<() => Promise<ReturnType<typeof vocabulary>>>()
      .mockRejectedValueOnce(new Error("db"))
      .mockResolvedValueOnce(vocabulary("b"));
    await expect(loadVocabularyCached(failing, () => 0, flaky)).rejects.toThrow("db");
    await expect(loadVocabularyCached(failing, () => 0, flaky)).resolves.toBeDefined();
  });

  it("invalidates on demand", async () => {
    const db = makeDb();
    const load = vi.fn(async () => vocabulary("c"));
    await loadVocabularyCached(db, () => 0, load);
    invalidateVocabularyCache(db);
    await loadVocabularyCached(db, () => 0, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
