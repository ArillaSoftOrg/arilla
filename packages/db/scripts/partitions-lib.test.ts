import assert from "node:assert/strict";
import { test } from "node:test";
import { partitionName } from "./ensure-partitions.ts";
import { horizonStatus, MONTHS_AHEAD, monthsFrom, partitionMonth } from "./partitions-lib.ts";

const NOV_13 = new Date(Date.UTC(2026, 10, 13, 20, 0));

test("partitionMonth: pg_get_expr ciktisindan alt sinir ayi", () => {
  assert.equal(
    partitionMonth("FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00')"),
    "2026-11",
  );
  assert.equal(partitionMonth("FOR VALUES FROM ('2027-01-01') TO ('2027-02-01')"), null);
  assert.equal(partitionMonth("FOR VALUES FROM ('2027-01-01T00:00:00Z') TO ('x')"), "2027-01");
  assert.equal(partitionMonth("DEFAULT"), null);
});

test("monthsFrom: yil devri", () => {
  assert.deepEqual(monthsFrom(new Date(Date.UTC(2026, 11, 31, 23, 59)), 3), [
    "2026-12",
    "2027-01",
    "2027-02",
  ]);
});

test("12 Kasim 2026 uretim durumu: ufuk Ocak'ta biter -> UYARI (Subat eksik), KRITIK degil", () => {
  const present = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];
  const r = horizonStatus(present, NOV_13);
  assert.equal(r.level, "warn");
  assert.deepEqual(r.missing, ["2027-02"]);
});

test("gelecek ayin partition'i yoksa KRITIK (veri default'a dusmeden bir ay once)", () => {
  // 1 Ocak 2027: Ocak var, Subat yok -> Subat 1'den bir ay once KRITIK.
  const present = ["2026-12", "2027-01"];
  const r = horizonStatus(present, new Date(Date.UTC(2027, 0, 1, 6, 0)));
  assert.equal(r.level, "crit");
  assert.match(r.message, /2027-02/);
});

test("bu ayin partition'i yoksa KRITIK", () => {
  assert.equal(horizonStatus(["2026-12"], NOV_13).level, "crit");
});

test("politika ufku tam: OK", () => {
  const r = horizonStatus(["2026-11", "2026-12", "2027-01", "2027-02"], NOV_13);
  assert.equal(r.level, "ok");
  assert.deepEqual(r.missing, []);
});

test("aradaki bosluk da yakalanir", () => {
  const r = horizonStatus(["2026-11", "2027-01", "2027-02"], NOV_13);
  assert.equal(r.level, "crit");
  assert.deepEqual(r.missing, ["2026-12"]);
});

test("uretim ile ayni ad ve ay kurali; MONTHS_AHEAD uretimle ayni (3)", () => {
  assert.equal(MONTHS_AHEAD, 3);
  assert.equal(partitionName(new Date(Date.UTC(2027, 1, 1))), "price_point_2027_02");
});
