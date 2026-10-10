import { describe, expect, it } from "vitest";
import { evaluateIntentCase, INTENT_CASES, runIntentEval } from "./intent-eval.ts";

describe("niyet altin seti", () => {
  it("mevcut regresyon vakalarinin tamami gecer (deterministik)", () => {
    const { rows, summary } = runIntentEval();
    const failing = rows.filter((r) => r.failures.length > 0);
    expect(failing).toEqual([]);
    expect(summary.exactPassRate).toBe(1);
    expect(summary.action.macroF1).toBe(1);
  });

  it("ayni girdi iki kosuda ayni sonucu verir", () => {
    expect(runIntentEval().rows).toEqual(runIntentEval().rows);
  });

  it("yanlis etiketi yakalar (olcum gercekten olcuyor)", () => {
    const base = INTENT_CASES.find((c) => c.action === "clarify");
    if (!base) throw new Error("clarify vakasi yok");
    const row = evaluateIntentCase({ ...base, action: "search" });
    expect(row.failures.length).toBeGreaterThan(0);
  });

  it("sorgular tekrar etmez", () => {
    const keys = INTENT_CASES.map((c) => c.query.toLocaleLowerCase("tr"));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
