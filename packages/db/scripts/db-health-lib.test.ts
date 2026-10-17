import assert from "node:assert/strict";
import { test } from "node:test";
import { compactStatement, findRedundantIndexes, type IndexInfo } from "./db-health-lib.ts";

function index(partial: Partial<IndexInfo> & Pick<IndexInfo, "name" | "columns">): IndexInfo {
  return {
    table: "t",
    method: "btree",
    isUnique: false,
    isPrimary: false,
    predicate: null,
    sizeBytes: 0,
    ...partial,
  };
}

const names = (indexes: IndexInfo[]) => findRedundantIndexes(indexes).map((r) => r.name);

// Karisik yon (offer_id, observed_at DESC) ancak bas kolon esitlikle sorgulaniyorsa PK ile
// karsilanir; bu kullanim bilgisi katalogda yok, rapor temkinli davranir (0077 elle karar verdi).
test("ayni kolonlar: tum yonler ters ise gereksiz, karisik yon raporlanmaz", () => {
  const pk = index({
    name: "pk",
    columns: ["offer_id", "observed_at"],
    isUnique: true,
    isPrimary: true,
  });
  const desc = index({ name: "time_idx", columns: ["offer_id", "observed_at DESC"] });
  assert.deepEqual(names([pk, desc]), []);
  const allDesc = index({ name: "time_idx", columns: ["offer_id DESC", "observed_at DESC"] });
  assert.deepEqual(names([pk, allDesc]), ["time_idx"]);
});

test("on ek indeks gereksizdir; PK/UNIQUE asla onerilmez", () => {
  const uniq = index({
    name: "uniq",
    columns: ["target_type", "target_id", "kind", "model_version"],
    isUnique: true,
  });
  const prefix = index({ name: "target_idx", columns: ["target_type", "target_id"] });
  assert.deepEqual(findRedundantIndexes([uniq, prefix]), [
    { table: "t", name: "target_idx", coveredBy: "uniq", sizeBytes: 0 },
  ]);
});

test("kosul, yontem ve tablo farkliysa gereksiz sayilmaz", () => {
  const full = index({ name: "full", columns: ["expires_at"] });
  const partial = index({
    name: "partial",
    columns: ["expires_at"],
    predicate: "(consumed_at IS NULL)",
  });
  assert.deepEqual(names([full, partial]), []);
  const gin = index({ name: "gin", columns: ["title"], method: "gin" });
  assert.deepEqual(names([index({ name: "bt", columns: ["title", "id"] }), gin]), []);
  assert.deepEqual(
    names([
      index({ name: "a", columns: ["x"] }),
      index({ name: "b", table: "u", columns: ["x", "y"] }),
    ]),
    [],
  );
});

test("birebir ayni iki indeksten yalnizca biri raporlanir", () => {
  const a = index({ name: "a_idx", columns: ["x"] });
  const b = index({ name: "b_idx", columns: ["x"] });
  assert.deepEqual(names([a, b]), ["b_idx"]);
});

test("kolon sirasi onemlidir", () => {
  const ab = index({ name: "ab", columns: ["a", "b"] });
  const b = index({ name: "b", columns: ["b"] });
  assert.deepEqual(names([ab, b]), []);
});

test("sorgu metni tek satira indirilir ve kirpilir", () => {
  assert.equal(compactStatement("SELECT 1\n  FROM   t"), "SELECT 1 FROM t");
  const long = compactStatement(`SELECT ${"x, ".repeat(200)}`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});
