/** Karar 0174 (PR1b): iş sonucu okuyucusu — altı sonuç, eski biçim ve bozuk girdi. */
import { describe, expect, it } from "vitest";
import { JOB_OUTCOMES, OUTCOME_STATUS, runOutcome } from "./job-outcome.ts";

describe("runOutcome: altı sonuç", () => {
  it.each([
    ["completed", "success", { good: true, ran: true, tone: "good" }],
    ["no_input", "success", { good: true, ran: true, tone: "info" }],
    ["skipped_locked", "partial", { good: false, ran: false, tone: "warn" }],
    ["partial", "partial", { good: true, ran: true, tone: "warn" }],
    ["failed", "failed", { good: false, ran: false, tone: "bad" }],
    ["blocked_upstream", "partial", { good: false, ran: true, tone: "warn" }],
  ] as const)("%s (%s)", (outcome, status, expected) => {
    expect(OUTCOME_STATUS[outcome]).toBe(status);
    expect(runOutcome(status, { outcome, reason: "lock_busy" })).toEqual({
      kind: outcome,
      reason: "lock_busy",
      ...expected,
    });
  });

  it("sözleşme Python OUTCOMES ile aynı altı ad", () => {
    expect([...JOB_OUTCOMES].sort()).toEqual(
      ["blocked_upstream", "completed", "failed", "no_input", "partial", "skipped_locked"].sort(),
    );
  });
});

describe("runOutcome: eski biçim", () => {
  it("outcome anahtarı yoksa eski status mantığı; arıza sayılmaz", () => {
    expect(runOutcome("success", { considered: 3 })).toMatchObject({
      kind: "legacy",
      good: true,
      tone: "good",
    });
    expect(runOutcome("partial", {})).toMatchObject({ kind: "legacy", good: true, tone: "warn" });
    expect(runOutcome("failed", {})).toMatchObject({ kind: "legacy", good: false, tone: "bad" });
  });

  it("sürüyor: iyi değil, sonuç yok", () => {
    expect(runOutcome("running", { outcome: "completed" })).toMatchObject({
      kind: "running",
      good: false,
      ran: false,
    });
  });
});

describe("runOutcome: bozuk değerler başarılı sayılmaz", () => {
  it.each([
    ["bilinmeyen ad", "success", { outcome: "done" }],
    ["sayı", "success", { outcome: 1 }],
    ["JSON null", "success", { outcome: null }],
    ["nesne", "success", { outcome: { name: "completed" } }],
    ["dizi", "success", { outcome: ["completed"] }],
    ["büyük harf", "success", { outcome: "COMPLETED" }],
    ["status ile çelişki (completed/partial)", "partial", { outcome: "completed" }],
    ["status ile çelişki (failed/success)", "success", { outcome: "failed" }],
    ["status ile çelişki (skipped_locked/success)", "success", { outcome: "skipped_locked" }],
  ])("%s", (_label, status, detail) => {
    expect(runOutcome(status, detail)).toMatchObject({ kind: "invalid", good: false, ran: false });
  });

  it("detail nesne değilse eski biçim gibi okunur ve istisna fırlatmaz", () => {
    for (const detail of [null, undefined, "x", 3, ["outcome"]]) {
      expect(runOutcome("failed", detail).kind).toBe("legacy");
    }
  });

  it("bozuk gerekçe atılır, sonuç korunur", () => {
    expect(runOutcome("success", { outcome: "no_input", reason: "Bad Reason!" })).toMatchObject({
      kind: "no_input",
      reason: null,
    });
    expect(runOutcome("success", { outcome: "completed", reason: 7 }).reason).toBeNull();
  });
});
