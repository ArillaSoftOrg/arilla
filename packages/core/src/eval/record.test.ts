import { describe, expect, it } from "vitest";
import { runIntentEval } from "./intent-eval.ts";
import { COMPONENT_METRICS } from "./metric-keys.ts";
import { assertLocalRecordTarget, isIsolatedDatabaseName } from "./record.ts";
import { intentRecord, matchingRecord, searchRecord } from "./record-adapters.ts";

describe("assertLocalRecordTarget", () => {
  const env = (name: string) => ({ EVAL_RECORD_DB_NAME: name });
  const ok = "postgresql://u:p@localhost:5432/arilla_eval_test";

  it("onayli izole yerel test veritabanina izin verir", () => {
    expect(() => assertLocalRecordTarget(ok, env("arilla_eval_test"))).not.toThrow();
    expect(() =>
      assertLocalRecordTarget("postgresql://u:p@127.0.0.1:55432/scratch_db", env("scratch_db")),
    ).not.toThrow();
  });
  it.each([
    "postgresql://u:p@db.example.com:5432/arilla_eval_test",
    "postgresql://u:p@aws-0-eu.pooler.supabase.com:6543/postgres_test",
    "",
    "bozuk",
  ])("uzak/bozuk adresi reddeder: %s", (url) => {
    expect(() => assertLocalRecordTarget(url, env("arilla_eval_test"))).toThrow(/reddedildi/);
  });
  it("SSH tuneli senaryosu: localhost + uretim adli veritabani onaylansa bile reddedilir", () => {
    for (const name of ["arilla", "postgres", "production", "contest"]) {
      expect(() =>
        assertLocalRecordTarget(`postgresql://u:p@localhost:5432/${name}`, env(name)),
      ).toThrow(/izole/);
    }
  });
  it("onay degiskeni yok ya da farkli ise reddeder (miras kalan ortam gecmez)", () => {
    expect(() => assertLocalRecordTarget(ok, {})).toThrow(/EVAL_RECORD_DB_NAME/);
    expect(() => assertLocalRecordTarget(ok, env("baska_test"))).toThrow(/EVAL_RECORD_DB_NAME/);
  });
  it("tanimsiz adresi reddeder ve mesaj host/parola/ad icermez", () => {
    expect(() => assertLocalRecordTarget(undefined, {})).toThrow();
    try {
      assertLocalRecordTarget("postgresql://admin:hunter2@prod.internal:5432/arilla", {});
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/hunter2|prod\.internal|admin/);
    }
  });
  it("izole ad kalibi: test/eval/scratch/sandbox parcasi, alt dize degil", () => {
    expect(isIsolatedDatabaseName("arilla_quota_test")).toBe(true);
    expect(isIsolatedDatabaseName("eval")).toBe(true);
    expect(isIsolatedDatabaseName("contest")).toBe(false);
    expect(isIsolatedDatabaseName("latest_prod")).toBe(false);
  });
});

describe("adaptorler", () => {
  it("niyet: deterministik girdi, ayni surum etiketi ve metrikler; ham sorgu yok", () => {
    const { rows, summary } = runIntentEval();
    const a = intentRecord(rows, summary, "rules@x");
    const b = intentRecord(rows, summary, "rules@x");
    expect(a).toEqual(b);
    expect(a.component).toBe("gemini_intent");
    expect(a.snapshot.version).toMatch(/^intent-golden-[0-9a-f]{8}$/);
    expect(Object.keys(a.metrics).sort()).toEqual(
      COMPONENT_METRICS.gemini_intent.map((m) => m.key).sort(),
    );
    expect(a.cases.every((c) => /^[0-9a-f]{24}$/.test(c.caseKey))).toBe(true);
    expect(JSON.stringify(a.cases)).not.toContain("kask");
  });

  it("eslestirme: yalniz hatali ciftler vaka olur, siniflari dogru", () => {
    const r = matchingRecord(
      {
        pairs: 3,
        metrics: { queue_f1: 1 },
        errors: [
          { case: "x", expected_match: true },
          { case: "y", expected_match: false },
        ],
      },
      { should_match: [], should_not_match: [] },
      3,
      "thresholds-q0.63-a0.84",
    );
    expect(r.cases.map((c) => c.failureClass)).toEqual(["missed_match", "false_match"]);
  });

  it("arama: sinif atamasi", () => {
    const base = { absent: false, relevantInCatalog: 3, usedFallback: false };
    const r = searchRecord(
      [
        { ...base, q: "a", returned: 5, relevance: [1], zeroResultCorrect: null },
        { ...base, q: "b", returned: 0, relevance: [], zeroResultCorrect: null },
        { ...base, q: "c", returned: 4, relevance: [0, 0], zeroResultCorrect: null },
        { ...base, q: "d", absent: true, returned: 2, relevance: [], zeroResultCorrect: false },
        { ...base, q: "e", absent: true, returned: 0, relevance: [], zeroResultCorrect: true },
      ],
      "search@x",
    );
    expect(r.cases.map((c) => c.failureClass ?? c.outcome)).toEqual([
      "pass",
      "zero_result",
      "low_rank",
      "false_result",
      "pass",
    ]);
  });
});
