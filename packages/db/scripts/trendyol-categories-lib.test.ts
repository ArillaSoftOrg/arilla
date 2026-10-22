import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseTrendyolTree,
  renderParsedJson,
  renderSeedMigration,
  sha256Hex,
} from "./trendyol-categories-lib.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tree = (categories: unknown) => JSON.stringify({ categories });

test("agac duz listeye cevrilir: derinlik, yaprak, yol, kaynak sirasi", () => {
  const { nodes, stats } = parseTrendyolTree(
    tree([
      {
        id: 1,
        name: "Giyim",
        parentId: null,
        subCategories: [
          { id: 2, name: "Kadın", parentId: 1, subCategories: [] },
          {
            id: 3,
            name: "Erkek",
            parentId: 1,
            subCategories: [{ id: 4, name: "Gömlek", parentId: 3, subCategories: [] }],
          },
        ],
      },
      { id: 9, name: "Kitap", parentId: null, subCategories: [] },
    ]),
  );
  assert.deepEqual(
    nodes.map((node) => [node.id, node.depth, node.isLeaf, node.pathText]),
    [
      [1, 1, false, "Giyim"],
      [2, 2, true, "Giyim > Kadın"],
      [3, 2, false, "Giyim > Erkek"],
      [4, 3, true, "Giyim > Erkek > Gömlek"],
      [9, 1, true, "Kitap"],
    ],
  );
  assert.deepEqual(nodes[3]?.pathIds, [1, 3, 4]);
  assert.equal(stats.total, 5);
  assert.equal(stats.roots, 2);
  assert.equal(stats.leaves, 3);
  assert.equal(stats.maxDepth, 3);
});

test("butunluk bozuksa reddedilir; eksik ya da uydurma kategori uretilmez", () => {
  const bad: unknown[] = [
    [],
    [{ id: 1, name: "", parentId: null, subCategories: [] }],
    [{ id: 0, name: "A", parentId: null, subCategories: [] }],
    [
      {
        id: 1,
        name: "A",
        parentId: null,
        subCategories: [{ id: 2, name: "B", parentId: 99, subCategories: [] }],
      },
    ],
    [
      { id: 1, name: "A", parentId: null, subCategories: [] },
      { id: 1, name: "B", parentId: null, subCategories: [] },
    ],
  ];
  for (const categories of bad) {
    assert.throws(() => parseTrendyolTree(tree(categories)));
  }
  assert.throws(() => parseTrendyolTree("{}"));
  assert.throws(() => parseTrendyolTree("html"));
});

test("tohum migration'i idempotent ve yalnizca ekleme; tirnak kacirilir", () => {
  const { nodes, stats } = parseTrendyolTree(
    tree([{ id: 5, name: "Women's", parentId: null, subCategories: [] }]),
  );
  const sql = renderSeedMigration("0097", "abc", stats, nodes);
  assert.match(sql, /^-- kind: data/);
  assert.match(sql, /'Women''s'/);
  assert.equal((sql.match(/ON CONFLICT/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /\bINTO category\b/);
});

test("depodaki ham JSON: sayilar, butunluk ve uretilmis dosyalar uyumlu", () => {
  const refDir = join(packageRoot, "../../docs/reference/trendyol");
  const bytes = readFileSync(join(refDir, "product-categories.raw.json"));
  const { nodes, stats } = parseTrendyolTree(bytes.toString("utf8"));
  const sha = sha256Hex(bytes);
  assert.equal(stats.duplicateIds.length, 0);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  assert.equal(
    readFileSync(join(refDir, "product-categories.parsed.json"), "utf8"),
    renderParsedJson(sha, stats, nodes),
  );
  assert.equal(
    readFileSync(
      join(packageRoot, "migrations", "0097_trendyol_category_reference_seed.sql"),
      "utf8",
    ),
    renderSeedMigration("0097", sha, stats, nodes),
  );
});
