/**
 * Gercek bootstrap katalogu uzerinde metin arama regresyonu (0029).
 * Bootstrap merchant'lari yoksa (yerel katalog yuklenmemis) atlanir.
 * Esikler 2026-09-24 olcumunun biraz altinda: gurultuye degil gerilemeye bakar.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../../test-db.ts";
import { bootstrapMerchantIds, type EvalRow, evaluateAll } from "./run-eval.ts";

let rows: EvalRow[] = [];
let hasCatalog = false;

beforeAll(async () => {
  const db = getTestDb();
  hasCatalog = (await bootstrapMerchantIds(db)).length > 0;
  if (hasCatalog) rows = await evaluateAll(db);
}, 120_000);

describe("bootstrap search evaluation", () => {
  it("returns zero results when the catalog has nothing relevant", (ctx) => {
    if (!hasCatalog) ctx.skip();
    const expectedEmpty = rows.filter((row) => row.zeroResultCorrect !== null);
    expect(expectedEmpty.length).toBeGreaterThanOrEqual(8);
    for (const row of expectedEmpty) {
      expect({ q: row.q, returned: row.returned }).toEqual({ q: row.q, returned: 0 });
    }
  });

  it("puts a relevant product first for exact and brand queries", (ctx) => {
    if (!hasCatalog) ctx.skip();
    for (const row of rows.filter((r) => r.group === "exact" || r.group === "brand")) {
      expect({ q: row.q, first: row.firstRelevant }).toEqual({ q: row.q, first: 1 });
    }
  });

  it("keeps top-10 precision and does not regress", (ctx) => {
    if (!hasCatalog) ctx.skip();
    const scored = rows.filter((row) => row.zeroResultCorrect === null);
    const falsePositives = scored.reduce((n, row) => n + row.falsePositives.length, 0);
    const meanAt10 = scored.reduce((n, row) => n + row.relevantAt10, 0) / scored.length;
    // 2026-09-24: 0 yanlis pozitif, ilgili@10 ortalamasi 8.72 (eski: 91 / 6.97).
    expect(falsePositives).toBeLessThanOrEqual(3);
    expect(meanAt10).toBeGreaterThanOrEqual(8.3);
  });

  it("does not match a query word inside a longer word ('halı' vs 'halkalı')", (ctx) => {
    if (!hasCatalog) ctx.skip();
    const hali = rows.find((row) => row.q === "halı");
    expect(hali?.falsePositives).toEqual([]);
  });
});
