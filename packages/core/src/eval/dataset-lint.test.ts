import { describe, expect, it } from "vitest";
import bootstrap from "../search/eval/bootstrap-queries.json" with { type: "json" };
import candidates from "./candidates/intent-candidates.json" with { type: "json" };
import { findNearDuplicates, jaccard, tokens } from "./dataset-lint.ts";
import { INTENT_CASES } from "./intent-eval.ts";

describe("dataset-lint", () => {
  it("Turkce buyuk/kucuk harf farkini yok sayar", () => {
    expect(tokens("KASK, Arıyorum!")).toEqual(["kask", "arıyorum"]);
    expect(jaccard(tokens("Isı Kask"), tokens("ısı kask"))).toBe(1);
  });

  it("yakalayici gercekten yakalar", () => {
    const found = findNearDuplicates(["siyah bot erkek", "erkek siyah bot", "termos"]);
    expect(found).toHaveLength(1);
  });

  it("niyet altin setinde tekrar ya da asiri benzer vaka yok", () => {
    expect(findNearDuplicates(INTENT_CASES.map((c) => c.query))).toEqual([]);
  });

  it("arama sorgu setinde tekrar yok", () => {
    expect(
      findNearDuplicates(
        bootstrap.queries.map((q) => q.q),
        1,
      ),
    ).toEqual([]);
  });

  it("aday havuzu etiket tasimaz (sahte dogruluk etiketi yok)", () => {
    expect(candidates.status).toBe("unverified");
    for (const item of candidates.candidates) {
      expect(Object.keys(item).sort()).toEqual(["query", "why"]);
    }
  });

  it("aday havuzu kendi icinde ve altin setle cakisanlari raporlar", () => {
    // Cakisan adaylar altin sete tasinmaz; test yalnizca bunu gorunur kilar.
    const all = [...INTENT_CASES.map((c) => c.query), ...candidates.candidates.map((c) => c.query)];
    const duplicates = findNearDuplicates(all, 1).map((d) => d.b);
    expect(duplicates).toEqual(["kask"]);
  });
});
