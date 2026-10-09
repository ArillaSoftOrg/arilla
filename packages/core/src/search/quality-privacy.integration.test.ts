/**
 * `search_query_day` kimlik/sir suzgeci, gercek yerel Postgres:
 * - bolunmus kimlik ve sir benzeri sorgu hic yazilmaz
 * - normal ve ozel nitelikli alisveris sorgusu bugunku gibi yazilir
 * - tanınmayan kelimelerden kimlik/sir benzeri olan atilir
 *
 * Isaret rakam icermez: test sorgularinin rakam sayisini degistirmemeli.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { normalizeQueryText } from "./normalize.ts";
import { recordSearchQuality, recordTextSearchQuality } from "./quality.ts";

const TAG = `gizlilikq${Date.now()
  .toString(36)
  .replace(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "x")}`;

const BLOCKED = [
  "tc 123 456 789 01",
  "AIzaSyD-abcdefghijklmnopqrstuvwxyz12",
  "sk-proj_abcdefgh",
  "password=hunter2",
  "şifre: Gizli123",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
  "deadbeefcafebabe0042",
];

const RECORDABLE = [
  "siyah elbise",
  "iphone 15 pro max kılıf",
  "nike air force 1 42 numara",
  "samsung galaxy s24 ultra 512 gb",
  "rtx 4090 ekran kartı 24gb",
  "hamile pantolonu",
];

const tagged = (raw: string) => `${raw} ${TAG}`;

async function rowCount(queryNorm: string): Promise<number> {
  return withOwnerClient(async (client) => {
    const r = await client.query(
      "SELECT count(*)::int AS n FROM search_query_day WHERE query_norm = $1",
      [queryNorm],
    );
    return r.rows[0].n as number;
  });
}

const input = { resultCount: 0, usedFallback: false, clarification: false, parserTier: 2 };

describe("search_query_day kimlik/sır süzgeci - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM search_query_day WHERE query_norm LIKE $1", [`%${TAG}%`]);
    });
  });

  it("kimlik/sır benzeri sorgu yazılmaz", async () => {
    for (const raw of BLOCKED) {
      expect(await recordTextSearchQuality(db, { ...input, query: tagged(raw) })).toBe("skipped");
      expect(await rowCount(normalizeQueryText(tagged(raw)))).toBe(0);
    }
  });

  it("normal ve özel nitelikli alışveriş sorgusu yazılır", async () => {
    for (const raw of RECORDABLE) {
      expect(await recordTextSearchQuality(db, { ...input, query: tagged(raw) })).toBe("recorded");
      expect(await rowCount(normalizeQueryText(tagged(raw)))).toBe(1);
    }
  });

  it("tanınmayan kelimelerden kimlik/sır benzeri olan atılır", async () => {
    const queryNorm = `yogamatı ${TAG}`;
    expect(
      await recordSearchQuality(db, {
        ...input,
        queryNorm,
        unrecognizedTerms: [
          "yogamatı",
          "sk-proj_abcdefgh",
          "password=hunter2",
          "deadbeefcafebabe0042",
          "galaxys24ultra512gb",
          "123456789",
        ],
      }),
    ).toBe("recorded");
    const terms = await withOwnerClient(async (client) => {
      const r = await client.query(
        "SELECT unrecognized_terms FROM search_query_day WHERE query_norm = $1",
        [queryNorm],
      );
      return r.rows[0].unrecognized_terms as string[];
    });
    expect(terms).toEqual(["yogamatı"]);
  });
});
