/**
 * `resolveQuery` gizlilik kapisi - veritabanisiz. Sahte `Database` yalnizca
 * `lexicon` okumasina izin verir; `query_resolution`'a herhangi bir erisim
 * (okuma, yazma) testi dusurur. Kapinin kurallari `queryContentIneligibility`
 * testlerinde; burada yalnizca `resolveQuery`'nin onu dogru yerde kullandigi.
 */
import { type Database, lexicon } from "@arilla/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryContentIneligibility } from "./interpretation-eligibility.ts";
import type { LexiconEntry } from "./lexicon.ts";
import { normalizeQueryText } from "./normalize.ts";
import { parseQueryText } from "./parse-query.ts";
import { resolveQuery } from "./query-resolution.ts";
import { BLOCKED_QUERIES, NORMAL_QUERIES } from "./query-resolution-test-cases.ts";

const LEXICON: LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "category", surface: "elbise", normalized: "giyim/elbise", weight: 1 },
];

/** Yalnizca `lexicon` okumasina izin veren sahte veritabani. */
function lexiconOnlyDb() {
  const touched: string[] = [];
  const forbidden = (op: string) => () => {
    touched.push(op);
    throw new Error(`query_resolution erisimi yasak: ${op}`);
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== lexicon) return forbidden("select")();
        return Promise.resolve(LEXICON.map((entry, i) => ({ id: i + 1, ...entry })));
      },
    }),
    update: forbidden("update"),
    insert: forbidden("insert"),
    delete: forbidden("delete"),
    execute: forbidden("execute"),
  };
  return { db: db as unknown as Database, touched };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveQuery gizlilik kapisi", () => {
  it.each(BLOCKED_QUERIES)("engellenir: $label", ({ raw, reason }) => {
    expect(queryContentIneligibility(normalizeQueryText(raw))).toBe(reason);
  });

  it.each(NORMAL_QUERIES)("normal sorgu kapidan gecer: %s", (raw) => {
    expect(queryContentIneligibility(normalizeQueryText(raw))).toBeNull();
  });

  it.each(BLOCKED_QUERIES)(
    "$label: query_resolution'a dokunmadan taze deterministik ayristirma",
    async ({ raw }) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { db, touched } = lexiconOnlyDb();

      const result = await resolveQuery(db, raw);

      expect(touched).toEqual([]);
      expect(result).toEqual({
        parsed: parseQueryText(raw, LEXICON),
        parserTier: 2,
        needsClarification: false,
        candidateCategories: null,
        cacheHit: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("engellenen sorgu sozluk eslesmesini korur (ayni ayristirici)", async () => {
    const { db } = lexiconOnlyDb();
    const result = await resolveQuery(db, "hamileyim siyah elbise");
    expect(result.parsed.filters.category_path).toBe("giyim/elbise");
    expect(result.parsed.filters.color).toEqual(["black"]);
  });

  it.each(NORMAL_QUERIES)("normal sorgu onbellek yoluna gider: %s", async (raw) => {
    const { db, touched } = lexiconOnlyDb();
    await expect(resolveQuery(db, raw)).rejects.toThrow(/query_resolution erisimi yasak/);
    expect(touched).toEqual(["update"]);
  });
});
