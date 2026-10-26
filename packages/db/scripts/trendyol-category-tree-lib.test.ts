import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseTrendyolTree, sha256Hex, type TrendyolNode } from "./trendyol-categories-lib.ts";
import {
  type BaselineCategory,
  fold,
  MIGRATION_NUMBER,
  parseBaseline,
  planTree,
  RESERVED_SEED_SLUGS,
  renderCsv,
  renderMigration,
  renderRollback,
  slugify,
} from "./trendyol-category-tree-lib.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(packageRoot, "../../docs/reference");

/** Sentetik Trendyol agaci: [id, ad, ebeveyn]. Sira derinlik-oncelikli degildir (plan siralar). */
function tree(entries: [number, string, number | null][]): TrendyolNode[] {
  const byId = new Map(entries.map(([id, name, parent]) => [id, { id, name, parent }]));
  const chain = (id: number): number[] => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`yok: ${id}`);
    return entry.parent === null ? [id] : [...chain(entry.parent), id];
  };
  return entries.map(([id, name, parentId]) => {
    const pathIds = chain(id);
    return {
      id,
      name,
      parentId,
      depth: pathIds.length,
      isLeaf: !entries.some(([, , parent]) => parent === id),
      pathIds,
      pathText: pathIds.map((x) => byId.get(x)?.name).join(" > "),
    };
  });
}

const base = (...items: [string, string, string][]): BaselineCategory[] =>
  items.map(([path, slug, name]) => ({ path, slug, name }));

const byExternal = (rows: ReturnType<typeof planTree>["rows"], id: number) => {
  const row = rows.find((r) => r.externalId === id);
  assert.ok(row, `satir yok: ${id}`);
  return row;
};

test("fold: Turkce buyuk/kucuk, aksan ve & / farki ortadan kalkar", () => {
  assert.equal(fold("Spor & Outdoor"), fold("Spor / Outdoor"));
  assert.equal(fold("Süpermarket"), fold("Supermarket"));
  assert.equal(fold("İç Giyim"), "ic giyim");
  assert.equal(fold("ILIK"), "ilik");
  assert.equal(slugify("Hobi & Eğlence"), "hobi-eglence");
  assert.equal(slugify("Bot & Çizme"), "bot-cizme");
  assert.notEqual(fold("Akıllı Bileklik"), fold("Akıllı Bileklikler")); // cogul = ayni DEGIL
});

test("kok: ayni adli TEK mevcut kok eslesir; cocuk yalniz eslesen ebeveyn altinda eslesir", () => {
  const nodes = tree([
    [1, "Elektronik", null],
    [2, "Telefon", 1],
    [3, "Kulaklık", 1],
    [4, "Yeni Dal", 1],
  ]);
  const { rows, summary } = planTree(
    nodes,
    base(
      ["elektronik", "elektronik", "Elektronik"],
      ["elektronik/telefon", "elektronik-telefon", "Telefon"],
      ["elektronik/ses", "elektronik-ses", "Ses"],
      ["moda/telefon", "moda-telefon", "Telefon"], // FARKLI ebeveyn: karistirilmaz
    ),
    [],
  );
  assert.deepEqual(
    rows.map((r) => [r.externalId, r.action, r.path]),
    [
      [1, "match", "elektronik"],
      [2, "match", "elektronik/telefon"],
      [3, "create", "elektronik/kulaklik"],
      [4, "create", "elektronik/yeni-dal"],
    ],
  );
  assert.equal(summary.matched, 2);
  assert.equal(summary.created, 2);
});

test("ayni ad ama farkli ebeveyn: mevcut dugume ESLENMEZ, ayri olusturulur", () => {
  const nodes = tree([
    [1, "Giyim", null],
    [2, "Saat", 1],
  ]);
  const { rows } = planTree(nodes, base(["moda/aksesuar/saat", "moda-aksesuar-saat", "Saat"]), []);
  assert.equal(byExternal(rows, 2).action, "create");
  assert.equal(byExternal(rows, 2).path, "giyim/saat");
});

test("ebeveyni olusturulmus (eslesmemis) dugumun altinda mevcut aday aranmaz", () => {
  const nodes = tree([
    [1, "Hobi", null],
    [2, "Müzik", 1],
  ]);
  const { rows } = planTree(nodes, base(["muzik", "muzik", "Müzik"]), []);
  assert.deepEqual(
    rows.map((r) => [r.action, r.path]),
    [
      ["create", "hobi"],
      ["create", "hobi/muzik"],
    ],
  );
});

test("belirsizlik eslesme yapmaz: ayni adli iki Trendyol kardesi ya da iki mevcut aday", () => {
  const twins = planTree(
    tree([
      [1, "Elektronik", null],
      [2, "Optik", 1],
      [3, "Optik", 1],
    ]),
    base(
      ["elektronik", "elektronik", "Elektronik"],
      ["elektronik/optik", "elektronik-optik", "Optik"],
    ),
    [],
  );
  assert.deepEqual(
    twins.rows.map((r) => [r.externalId, r.action, r.path]),
    [
      [1, "match", "elektronik"],
      [2, "create", "elektronik/optik-ty2"],
      [3, "create", "elektronik/optik-ty3"],
    ],
  );
  const doubleCandidate = planTree(
    tree([
      [1, "Elektronik", null],
      [2, "Ses", 1],
    ]),
    base(
      ["elektronik", "elektronik", "Elektronik"],
      ["elektronik/ses", "elektronik-ses", "Ses"],
      ["elektronik/ses-2", "elektronik-ses-2", "Ses"],
    ),
    [],
  );
  assert.equal(byExternal(doubleCandidate.rows, 2).action, "create");
});

test("yol cakismasi (ayni slug, farkli ad) sonekle ayrilir; mevcut dugum degismez", () => {
  const { rows, summary } = planTree(
    tree([
      [1, "Elektronik", null],
      [2, "Akıllı Bileklik", 1],
    ]),
    base(
      ["elektronik", "elektronik", "Elektronik"],
      ["elektronik/akilli-bileklik", "elektronik-akilli-bileklik", "Akıllı Bileklikler"],
    ),
    [],
  );
  assert.equal(byExternal(rows, 2).path, "elektronik/akilli-bileklik-ty2");
  assert.equal(byExternal(rows, 2).slug, "elektronik-akilli-bileklik-ty2");
  assert.equal(summary.pathSuffixed, 1);
});

test("ayrilmis tohum slug'i olusturulan dugume verilmez (tohum onu ezmesin)", () => {
  const { rows, summary } = planTree(
    tree([[1, "Ayakkabı", null]]),
    base(["moda/ayakkabi", "moda-ayakkabi", "Ayakkabı"]),
    ["ayakkabi"],
  );
  assert.equal(rows[0]?.path, "ayakkabi");
  assert.equal(rows[0]?.slug, "ayakkabi-ty1");
  assert.equal(summary.slugSuffixed, 1);
});

test("ebeveyn her zaman cocuktan once islenir ve yol ebeveyn yoluyla tutarlidir", () => {
  const { rows } = planTree(
    tree([
      [5, "Kök", null],
      [9, "Çocuk", 5],
      [7, "Torun", 9],
    ]),
    [],
    [],
  );
  assert.deepEqual(
    rows.map((r) => r.depth),
    [1, 2, 3],
  );
  assert.deepEqual(
    rows.map((r) => r.path),
    ["kok", "kok/cocuk", "kok/cocuk/torun"],
  );
});

test("plan deterministiktir: ayni girdi, ayni cikti (kaynak sirasindan bagimsiz kimlik sirasi)", () => {
  const nodes = tree([
    [1, "A", null],
    [3, "C", 1],
    [2, "B", 1],
  ]);
  const one = planTree(nodes, [], []);
  const two = planTree([...nodes].reverse(), [], []);
  assert.deepEqual(one.rows, two.rows);
});

// ---------------------------------------------------------------------------
// Gercek veri: 3.867 Trendyol kategorisinin TAMAMI eslenir ya da olusturulur
// ---------------------------------------------------------------------------

const rawBytes = readFileSync(join(docsRoot, "trendyol/product-categories.raw.json"));
const { nodes: realNodes } = parseTrendyolTree(rawBytes.toString("utf8"));
const baseline = parseBaseline(
  readFileSync(join(docsRoot, "categories/manicepte-baseline-158.tsv"), "utf8"),
);
const real = planTree(realNodes, baseline);

test("taban: 158 kategori, 10 ana kategori, yollar benzersiz, slug = yol (-)", () => {
  assert.equal(baseline.length, 158);
  assert.equal(baseline.filter((c) => !c.path.includes("/")).length, 10);
  assert.equal(new Set(baseline.map((c) => c.path)).size, 158);
  assert.equal(new Set(baseline.map((c) => c.slug)).size, 158);
  for (const c of baseline) assert.equal(c.slug, c.path.replaceAll("/", "-"));
});

test("Trendyol'un 3.867 kategorisinin tamami tam bir kez eslenir ya da olusturulur", () => {
  assert.equal(realNodes.length, 3867);
  assert.equal(real.rows.length, 3867);
  assert.equal(real.summary.matched + real.summary.created, 3867);
  assert.equal(new Set(real.rows.map((r) => r.externalId)).size, 3867);
  assert.deepEqual(
    new Set(real.rows.map((r) => r.externalId)),
    new Set(realNodes.map((n) => n.id)),
  );
});

test("yalniz belirleyici esleme: ayni ebeveyn baglaminda ayni ad (5 dugum)", () => {
  const matched = real.rows.filter((r) => r.action === "match").map((r) => r.path);
  assert.deepEqual(matched.sort(), [
    "elektronik",
    "elektronik/giyilebilir",
    "elektronik/telefon",
    "spor-outdoor",
    "supermarket",
  ]);
  // Hicbir eslesme baska bir ebeveynden gelmez: eslesen her satirin yolu taban yoludur.
  const basePaths = new Set(baseline.map((c) => c.path));
  for (const row of real.rows.filter((r) => r.action === "match")) {
    assert.ok(basePaths.has(row.path));
    assert.equal(fold(row.name), fold(row.matchedName ?? ""));
  }
});

test("16 ana kategori (3'u mevcutla eslesir, 13'u yeni) ve 6 seviye", () => {
  assert.equal(real.summary.roots, 16);
  assert.equal(real.summary.newRoots, 13);
  assert.equal(real.summary.maxDepth, 6);
  assert.deepEqual(real.summary.perDepth, {
    "1": 16,
    "2": 119,
    "3": 1134,
    "4": 1870,
    "5": 697,
    "6": 31,
  });
});

test("olusturulan dugumler: yol ve slug benzersiz, tabanla ve tohum slug'lariyla cakismaz", () => {
  const created = real.rows.filter((r) => r.action === "create");
  assert.equal(created.length, 3862);
  const paths = created.map((r) => r.path);
  const slugs = created.map((r) => r.slug);
  assert.equal(new Set(paths).size, created.length);
  assert.equal(new Set(slugs).size, created.length);
  const basePaths = new Set(baseline.map((c) => c.path));
  const baseSlugs = new Set(baseline.map((c) => c.slug));
  for (const row of created) {
    assert.ok(!basePaths.has(row.path), `taban yolu ezildi: ${row.path}`);
    assert.ok(!baseSlugs.has(row.slug), `taban slug'i ezildi: ${row.slug}`);
    assert.ok(!RESERVED_SEED_SLUGS.includes(row.slug), `tohum slug'i: ${row.slug}`);
    assert.match(row.path, /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/);
    assert.equal(row.path.split("/").length, row.depth);
  }
});

test("hiyerarsi korunur: her olusturulan dugumun ebeveyn yolu, Trendyol ebeveyninin yoludur", () => {
  const pathOf = new Map(real.rows.map((r) => [r.externalId, r.path]));
  for (const row of real.rows) {
    if (row.parentExternalId === null) {
      assert.ok(!row.path.includes("/"));
      continue;
    }
    const parentPath = pathOf.get(row.parentExternalId);
    assert.ok(parentPath, `ebeveyn plan disinda: ${row.externalId}`);
    if (row.action === "create") {
      assert.equal(row.path.slice(0, row.path.lastIndexOf("/")), parentPath);
    }
  }
});

test("ayni adli farkli ebeveynli Trendyol dugumleri birbirine karistirilmaz", () => {
  const seen = new Map<string, string>();
  for (const row of real.rows) {
    const key = `${fold(row.name)}|${row.parentExternalId}`;
    if (row.action === "create" && seen.has(key)) {
      // Ayni ebeveynde ayni ad: iki ayri dugum, ayri yol.
      assert.notEqual(seen.get(key), row.path);
    }
    seen.set(key, row.path);
  }
  // Ayni ad, farkli ebeveyn: ayri dugumler (ornek "Elektronik Optik Ürünler").
  const optics = real.rows.filter((r) => fold(r.name) === "elektronik optik urunler");
  assert.ok(optics.length >= 2);
  assert.equal(new Set(optics.map((r) => r.path)).size, optics.length);
});

test("ayrilmis tohum slug listesi seed.ts'teki kategori slug'larini kapsar", () => {
  const seed = readFileSync(join(packageRoot, "scripts/seed.ts"), "utf8");
  const start = seed.indexOf("const CATEGORIES");
  const end = seed.indexOf("const LEAF_CATEGORIES");
  assert.ok(start > 0 && end > start);
  const slugs = [...seed.slice(start, end).matchAll(/^\s{4}slug: "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(slugs.length >= 10);
  for (const slug of slugs) assert.ok(RESERVED_SEED_SLUGS.includes(slug ?? ""), `eksik: ${slug}`);
});

test("uretilen migration, CSV ve geri alma betigi plan ile guncel", () => {
  const sha = sha256Hex(rawBytes);
  const read = (path: string) => readFileSync(path, "utf8");
  assert.equal(
    read(join(packageRoot, "migrations", `${MIGRATION_NUMBER}_trendyol_category_tree.sql`)),
    renderMigration(sha, real.rows, real.summary),
  );
  assert.equal(read(join(docsRoot, "trendyol/category-tree-map.csv")), renderCsv(real.rows));
  assert.equal(
    read(join(docsRoot, "trendyol/category-tree-rollback.sql")),
    renderRollback(real.summary),
  );
});

test("migration: yalniz ekleme (DELETE/UPDATE/DROP yok), idempotent ve RAISE EXCEPTION yok", () => {
  const sql = renderMigration("0".repeat(64), real.rows, real.summary);
  assert.ok(sql.startsWith("-- kind: data\n"));
  assert.doesNotMatch(sql, /\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/);
  assert.doesNotMatch(sql, /RAISE EXCEPTION/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM external_category_map/);
  assert.match(sql, /FALSE\)\n {12}RETURNING id INTO cat_id/);
  assert.equal(sql.match(/^ {12}\(\d+, /gm)?.length, 3867);
});

test("geri alma betigi yalniz bu migration'in olusturdugunu siler, tek ifadede", () => {
  const sql = renderRollback(real.summary);
  assert.match(sql, /decided_by = 'migration:0102' AND note = 'created'/);
  assert.equal(sql.match(/DELETE FROM category/g)?.length, 1);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
});

test("CSV: baslik + 3.867 satir; tirnak ve virgul guvenli", () => {
  const lines = renderCsv(real.rows).trimEnd().split("\n");
  assert.equal(lines.length, 3868);
  assert.match(lines[0] ?? "", /^trendyol_id,trendyol_parent_id,/);
  const quoted = renderCsv([
    {
      externalId: 1,
      parentExternalId: null,
      depth: 1,
      action: "create",
      path: "a",
      slug: "a",
      name: 'Ad, "tirnakli"',
      matchedName: null,
      trendyolPath: "X",
    },
  ]);
  assert.match(quoted, /"Ad, ""tirnakli"""/);
});
