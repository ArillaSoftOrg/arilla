import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReadOnlySql, CATALOG_TABLES, PROBES, sanitizeError } from "./catalog-telemetry.ts";

test("her telemetri sorgusu salt okunur denetimden gecer", () => {
  for (const probe of PROBES) assert.doesNotThrow(() => assertReadOnlySql(probe.sql), probe.key);
});

test("yazma, DDL, bakim ve coklu ifade reddedilir", () => {
  const bad = [
    "UPDATE offer SET is_active = false",
    "SELECT 1; DROP TABLE offer",
    "WITH x AS (DELETE FROM offer RETURNING 1) SELECT * FROM x",
    "VACUUM offer",
    "SELECT 1 FROM offer; ANALYZE",
    "SELECT set_config('x', 'y', false); SET statement_timeout = 0",
  ];
  for (const sql of bad) assert.throws(() => assertReadOnlySql(sql), sql);
});

test("sabit metin ve satir aciklamasi yanlis pozitif uretmez", () => {
  assert.doesNotThrow(() => assertReadOnlySql("SELECT 'update delete' AS t -- drop table"));
});

test("katalog cekirdegi beklenen tablolari kapsar", () => {
  for (const name of ["offer", "offer_variant", "product", "price_point", "embedding"]) {
    assert.ok((CATALOG_TABLES as readonly string[]).includes(name), name);
  }
});

test("hata ciktisi baglanti adresi ve parola izi tasimaz", () => {
  const leaked = sanitizeError(
    new Error("connect failed postgresql://arilla:s3cret@db.example.com:5432/x password=hunter2"),
  );
  assert.ok(!leaked.includes("s3cret"));
  assert.ok(!leaked.includes("db.example.com"));
  assert.ok(!leaked.includes("hunter2"));
});

test("pg_stat_statements sorgusu sabit metinleri maskeler ve satirlari kisaltir", () => {
  const probe = PROBES.find((p) => p.key === "statements");
  assert.ok(probe);
  assert.match(probe.sql, /regexp_replace/);
  assert.match(probe.sql, /left\(/);
  assert.equal(probe.requires, "pg_stat_statements");
});

test("hicbir sorgu yazma/DDL/bakim kelimesi tasimaz", () => {
  for (const probe of PROBES) {
    assert.doesNotMatch(
      probe.sql,
      /\b(insert|update|delete|alter|drop|vacuum|analyze|reindex)\b/i,
      probe.key,
    );
  }
});
