import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@arilla/db";
import { describe, expect, it, vi } from "vitest";
import type { LexiconEntry } from "../lexicon.ts";
import { parseQueryText } from "../parse-query.ts";
import { applyCorrectionsToParsed, NormalizationStats, normalizeParsedForSearch } from "./apply.ts";
import { normalizeQuery } from "./index.ts";
import { buildVocabulary } from "./vocabulary.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "vocabulary.fixture.json"), "utf8")) as {
  categories: string[];
  lexicon: LexiconEntry[];
};
const { brands } = JSON.parse(
  readFileSync(
    join(here, "..", "..", "eval", "datasets", "query-normalization.brands.json"),
    "utf8",
  ),
) as { brands: string[] };
const vocabulary = buildVocabulary({
  categories: fixture.categories,
  lexicon: fixture.lexicon,
  brands,
});
// Ayristirici icin yalniz es anlam satirlari (marka/kategori filtresi uretmesin).
const lexicon: LexiconEntry[] = fixture.lexicon
  .filter((entry) => entry.kind === "synonym")
  .map((entry) => ({ ...entry, weight: entry.weight ?? 1 }));
const db = {} as Database;

function parsedFor(text: string) {
  return parseQueryText(text, lexicon);
}

function applied(text: string) {
  const parsed = parsedFor(text);
  return {
    parsed,
    result: applyCorrectionsToParsed(parsed, normalizeQuery(parsed.unparsed, vocabulary), lexicon),
  };
}

describe("applyCorrectionsToParsed", () => {
  it("adds the correction as an alternative and keeps the original token first", () => {
    const { result } = applied("zamzung kılıf");
    const slot = result.text_slots?.find((s) => s[0] === "zamzung");
    expect(slot).toBeDefined();
    expect(slot).toContain("samsung");
  });

  it("brings lexicon synonyms of the corrected phrase (TR -> EN bridge)", () => {
    const { result } = applied("şarz aleti");
    const slot = result.text_slots?.[0] ?? [];
    expect(slot[0]).toBe("sarz aleti");
    expect(slot).toContain("sarj aleti");
    expect(slot.some((alt) => alt.includes("charger"))).toBe(true);
  });

  it("never changes filters or the unparsed text", () => {
    const { parsed, result } = applied("zamzung kılıf");
    expect(result.filters).toEqual(parsed.filters);
    expect(result.unparsed).toBe(parsed.unparsed);
  });

  it("does not mutate the (cached) parsed object", () => {
    const parsed = parsedFor("blutut kulaklık");
    const snapshot = JSON.stringify(parsed);
    const result = applyCorrectionsToParsed(
      parsed,
      normalizeQuery(parsed.unparsed, vocabulary),
      lexicon,
    );
    expect(result).not.toBe(parsed);
    expect(JSON.stringify(parsed)).toBe(snapshot);
  });

  it("returns the same object when nothing needs correcting", () => {
    const { parsed, result } = applied("bluetooth kulaklık");
    expect(result).toBe(parsed);
  });

  it("does not search for a negated brand (zamzung olmasın)", () => {
    const { parsed, result } = applied("zamzung olmasın kulaklık");
    for (const slot of result.text_slots ?? []) expect(slot).not.toContain("samsung");
    expect(result).toBe(parsed);
  });

  it("keeps model codes untouched in the slots", () => {
    const { result } = applied("samsng a55 kılıf");
    expect(result.text_slots?.some((s) => s[0] === "a55" && s.length === 1)).toBe(true);
  });

  it("ignores a normalization computed on another text", () => {
    const parsed = parsedFor("zamzung kılıf");
    const other = normalizeQuery("zamzung kılıflar", vocabulary);
    expect(applyCorrectionsToParsed(parsed, other, lexicon)).toBe(parsed);
  });
});

describe("normalizeParsedForSearch", () => {
  const loadVocabulary = vi.fn(async () => vocabulary);
  const loadLexicon = vi.fn(async () => lexicon);

  it("off: does no work and returns the same object", async () => {
    const parsed = parsedFor("zamzung kılıf");
    const log = vi.fn();
    const result = await normalizeParsedForSearch(db, parsed, {
      mode: "off",
      loadVocabulary,
      loadLexicon,
      log,
    });
    expect(result).toBe(parsed);
    expect(loadVocabulary).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("defaults to off when the flag is not set", async () => {
    const previous = process.env.QUERY_NORMALIZATION_MODE;
    delete process.env.QUERY_NORMALIZATION_MODE;
    try {
      const parsed = parsedFor("zamzung kılıf");
      expect(await normalizeParsedForSearch(db, parsed, { loadVocabulary, loadLexicon })).toBe(
        parsed,
      );
    } finally {
      if (previous !== undefined) process.env.QUERY_NORMALIZATION_MODE = previous;
    }
  });

  it("shadow: returns immediately without waiting for the load; logs counts only", async () => {
    const parsed = parsedFor("zamzung kılıf");
    const log = vi.fn();
    let release: (value: typeof vocabulary) => void = () => {};
    const slowVocabulary = () =>
      new Promise<typeof vocabulary>((resolve) => {
        release = resolve;
      });
    const result = await normalizeParsedForSearch(db, parsed, {
      mode: "shadow",
      loadVocabulary: slowVocabulary,
      loadLexicon,
      log,
    });
    // Yukleme henuz bitmedi; arama ozgun nesneyle hemen devam eder.
    expect(result).toBe(parsed);
    expect(log).not.toHaveBeenCalled();
    release(vocabulary);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toMatch(/^\[normalize\] mode=shadow window=1 triggered=1 corrections=1 brand=1 /);
    expect(line).not.toContain("zamzung");
    expect(line).not.toContain("samsung");
  });

  it("shadow: a background failure is counted and never reaches the caller", async () => {
    const parsed = parsedFor("zamzung kılıf");
    const log = vi.fn();
    const result = await normalizeParsedForSearch(db, parsed, {
      mode: "shadow",
      loadVocabulary: async () => {
        throw new TypeError("db down");
      },
      loadLexicon,
      log,
    });
    expect(result).toBe(parsed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toHaveBeenCalledWith("[normalize] skipped: TypeError");
  });

  it("on: gives up after the load budget and continues with the original", async () => {
    const parsed = parsedFor("zamzung kılıf");
    const log = vi.fn();
    const result = await normalizeParsedForSearch(db, parsed, {
      mode: "on",
      loadVocabulary: () => new Promise(() => {}),
      loadLexicon,
      log,
      loadBudgetMs: 5,
    });
    expect(result).toBe(parsed);
    expect(log).toHaveBeenCalledWith("[normalize] skipped: LoadTimeout");
  });

  it("aggregates a window of searches into one count-only line", () => {
    const lines: string[] = [];
    const stats = new NormalizationStats(3, (line) => lines.push(line));
    const sample = {
      brand: 0,
      ambiguous: 0,
      applied: false,
      ms: 0.5,
      version: "1+x",
      mode: "shadow" as const,
    };
    stats.record({ ...sample, corrections: 0 });
    stats.record({ ...sample, corrections: 2, brand: 1 });
    expect(lines).toEqual([]);
    stats.record({ ...sample, corrections: 0 });
    expect(lines).toEqual([
      "[normalize] mode=shadow window=3 triggered=1 corrections=2 brand=1 ambiguous=0 applied=0 errors=0 timeouts=0 p95ms=0.50 version=1+x",
    ]);
  });

  it("on: returns the corrected copy", async () => {
    const parsed = parsedFor("zamzung kılıf");
    const result = await normalizeParsedForSearch(db, parsed, {
      mode: "on",
      loadVocabulary,
      loadLexicon,
      log: () => {},
    });
    expect(result).not.toBe(parsed);
    expect(result.text_slots?.flat()).toContain("samsung");
  });

  it("never breaks search when loading fails", async () => {
    const parsed = parsedFor("zamzung kılıf");
    const log = vi.fn();
    const failing = async () => {
      throw new TypeError("db down");
    };
    const result = await normalizeParsedForSearch(db, parsed, {
      mode: "on",
      loadVocabulary: failing,
      loadLexicon,
      log,
    });
    expect(result).toBe(parsed);
    expect(log).toHaveBeenCalledWith("[normalize] skipped: TypeError");
  });
});
