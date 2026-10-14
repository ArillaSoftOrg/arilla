import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { migrationsDir } from "./lib.ts";
import { BASELINE, lintMigrations, stripSql } from "./migration-lint.ts";

const NEXT = String(BASELINE + 1).padStart(4, "0");
const rules = (name: string, sql: string) =>
  lintMigrations([{ name, sql }]).map((issue) => issue.rule);

test("depodaki tum migration'lar kurallara uygun", () => {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));
  assert.deepEqual(lintMigrations(files), []);
});

test("yinelenen numara ve gecersiz ad reddedilir", () => {
  const issues = lintMigrations([
    { name: "0010_a.sql", sql: "" },
    { name: "0010_b.sql", sql: "" },
    { name: "10_c.sql", sql: "" },
  ]);
  assert.deepEqual(
    issues.map((issue) => issue.rule),
    ["duplicate", "name"],
  );
});

test("price_point degistiren SQL her dosyada reddedilir; yorum ve metin sayilmaz", () => {
  assert.deepEqual(rules("0003_x.sql", "UPDATE price_point SET price = 1;"), ["append-only"]);
  assert.deepEqual(rules("0003_x.sql", "DELETE FROM ONLY price_point;"), ["append-only"]);
  assert.deepEqual(
    rules("0003_x.sql", "-- UPDATE price_point yasak\nSELECT 'DELETE FROM price_point';"),
    [],
  );
});

test("CONCURRENTLY reddedilir (calistirici islem icinde yurutur)", () => {
  assert.deepEqual(rules("0003_x.sql", "CREATE INDEX CONCURRENTLY i ON t (a);"), ["concurrently"]);
});

test("yeni dosya ilk satirda kind ister", () => {
  assert.deepEqual(rules(`${NEXT}_x.sql`, "CREATE TABLE t (a int);"), ["kind"]);
  assert.deepEqual(rules(`${NEXT}_x.sql`, "-- kind: schema\nCREATE TABLE t (a int);"), []);
  assert.deepEqual(rules(`${NEXT}_x.sql`, "-- kind: whatever\nSELECT 1;"), ["kind"]);
  // Eski dosyalar (baseline) bu kurala tabi degil.
  assert.deepEqual(rules("0064_x.sql", "CREATE TABLE t (a int);"), []);
});

test("yikici DDL yalnizca acik gerekceyle", () => {
  const destructive = [
    "ALTER TABLE t DROP COLUMN a;",
    "DROP TABLE t;",
    "ALTER TABLE t RENAME COLUMN a TO b;",
    "ALTER TABLE t ALTER COLUMN a TYPE bigint;",
    "ALTER TABLE t ALTER COLUMN a SET DATA TYPE bigint;",
    "ALTER TABLE t ALTER COLUMN a SET NOT NULL;",
    "TRUNCATE t;",
  ];
  for (const statement of destructive) {
    assert.deepEqual(
      rules(`${NEXT}_x.sql`, `-- kind: schema\n${statement}`),
      ["destructive"],
      statement,
    );
    assert.deepEqual(
      rules(
        `${NEXT}_x.sql`,
        `-- kind: schema\n-- allow-destructive: kod 2 surumdur kullanmiyor\n${statement}`,
      ),
      [],
      statement,
    );
  }
  // Eklemeci DDL serbest.
  assert.deepEqual(
    rules(
      `${NEXT}_x.sql`,
      "-- kind: schema\nALTER TABLE t ADD COLUMN b text;\nCREATE INDEX i ON t (b);",
    ),
    [],
  );
});

test("islem ifadeleri yazilmaz; DO blogu icindeki BEGIN serbest", () => {
  assert.deepEqual(rules(`${NEXT}_x.sql`, "-- kind: schema\nBEGIN;\nSELECT 1;\nCOMMIT;"), [
    "transaction",
  ]);
  assert.deepEqual(
    rules(`${NEXT}_x.sql`, "-- kind: data\nDO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;"),
    [],
  );
});

test("veri migration'i RAISE EXCEPTION ile dagitimi dusurmez", () => {
  const sql = "-- kind: data\nDO $$ BEGIN IF NOT FOUND THEN RAISE EXCEPTION 'yok'; END IF; END $$;";
  assert.deepEqual(rules(`${NEXT}_x.sql`, sql), ["data-raise"]);
  assert.deepEqual(
    rules(
      `${NEXT}_x.sql`,
      sql.replace("-- kind: data", "-- kind: data\n-- allow-raise: bos tabloda guvenli"),
    ),
    [],
  );
  // Sema migration'inda kendi degismezini koruyan RAISE serbest.
  assert.deepEqual(rules(`${NEXT}_x.sql`, sql.replace("data", "schema")), []);
});

test("stripSql yorumlari ve metinleri bosaltir", () => {
  assert.equal(stripSql("a -- b\nc /* d */ 'e''f' g").replace(/\s+/g, " ").trim(), "a c '' g");
});

test("REVOKE ... TRUNCATE yetki geri alimidir, yikici sayilmaz", () => {
  assert.deepEqual(
    rules(`${NEXT}_x.sql`, "-- kind: grant\nREVOKE UPDATE, DELETE, TRUNCATE ON t FROM arilla_app;"),
    [],
  );
});
