import { describe, expect, it } from "vitest";
import {
  compareRuns,
  falseMatchRate,
  multiclassReport,
  ndcgAtK,
  precisionAtK,
  precisionRecallF1,
  zeroResultRate,
} from "./metrics.ts";

describe("precisionRecallF1", () => {
  it("elle hesaplanan degerleri verir", () => {
    const r = precisionRecallF1({ tp: 8, fp: 2, fn: 4, tn: 86 });
    expect(r.precision).toBeCloseTo(0.8);
    expect(r.recall).toBeCloseTo(8 / 12);
    expect(r.f1).toBeCloseTo((2 * 0.8 * (8 / 12)) / (0.8 + 8 / 12));
  });
  it("olculemeyen durumda 0 doner, NaN degil", () => {
    expect(precisionRecallF1({ tp: 0, fp: 0, fn: 0, tn: 5 })).toEqual({
      precision: 0,
      recall: 0,
      f1: 0,
    });
  });
});

describe("falseMatchRate", () => {
  it("FP / (FP + TN)", () => {
    expect(falseMatchRate({ tp: 0, fp: 1, fn: 0, tn: 3 })).toBe(0.25);
    expect(falseMatchRate({ tp: 5, fp: 0, fn: 0, tn: 0 })).toBe(0);
  });
});

describe("multiclassReport", () => {
  const items = [
    { expected: "a", predicted: "a" },
    { expected: "a", predicted: "b" },
    { expected: "b", predicted: "b" },
    { expected: "b", predicted: "b" },
    { expected: "c", predicted: "a" },
  ] as const;
  it("macro-F1 sinif F1'lerinin ortalamasidir", () => {
    const r = multiclassReport(items);
    // a: p=1/2 r=1/2 f1=.5 | b: p=2/3 r=1 f1=.8 | c: p=0 r=0 f1=0
    expect(r.perClass.a.f1).toBeCloseTo(0.5);
    expect(r.perClass.b.f1).toBeCloseTo(0.8);
    expect(r.perClass.c.f1).toBe(0);
    expect(r.macroF1).toBeCloseTo((0.5 + 0.8 + 0) / 3);
    expect(r.accuracy).toBeCloseTo(3 / 5);
  });
  it("destegi olmayan sinif macro ortalamayi dusurmez", () => {
    const r = multiclassReport([{ expected: "a", predicted: "a" }], ["a", "b"]);
    expect(r.macroF1).toBe(1);
  });
});

describe("precisionAtK", () => {
  it("kisa liste eksik sonuc olarak cezalanir", () => {
    expect(precisionAtK([1, 0, 1], 5)).toBeCloseTo(2 / 5);
    expect(precisionAtK([1, 1, 1, 1, 1, 1], 5)).toBe(1);
    expect(precisionAtK([], 5)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("ideal sira 1 verir", () => {
    expect(ndcgAtK([3, 2, 1, 0], 10)).toBeCloseTo(1);
  });
  it("ilgili sonuc asagidaysa skor duser", () => {
    // Ideal havuz: tek ilgili urun var. Ucuncu siradaki: 1/log2(4) = 0.5.
    expect(ndcgAtK([1, 0, 0], 10, [1])).toBeCloseTo(1);
    expect(ndcgAtK([0, 0, 1], 10, [1])).toBeCloseTo(0.5);
  });
  it("bilinen ilgili urun kacirilirsa idealPool ile skor duser", () => {
    expect(ndcgAtK([1], 10, [1, 1, 1])).toBeLessThan(1);
  });
  it("hic ilgili yoksa 0 (NaN degil)", () => {
    expect(ndcgAtK([0, 0], 10)).toBe(0);
  });
});

describe("zeroResultRate", () => {
  it("bos donen sorgu kesri", () => {
    expect(zeroResultRate([0, 3, 0, 5])).toBe(0.5);
    expect(zeroResultRate([])).toBe(0);
  });
});

describe("compareRuns", () => {
  const dirs = { precision: "higher", falseMatchRate: "lower" } as const;
  it("iyilesme ve kotulesmeyi yonune gore ayirir", () => {
    const changes = compareRuns(
      { precision: 0.9, falseMatchRate: 0.0 },
      { precision: 0.8, falseMatchRate: 0.1 },
      dirs,
    );
    expect(changes.every((c) => c.regressed)).toBe(true);
    const better = compareRuns({ precision: 0.8 }, { precision: 0.9 }, dirs);
    expect(better[0]?.regressed).toBe(false);
  });
  it("tolerans icindeki oynama regresyon degildir", () => {
    const [c] = compareRuns({ precision: 0.9 }, { precision: 0.895 }, dirs, 0.01);
    expect(c?.regressed).toBe(false);
  });
  it("yalniz iki kosuda da olan metrikleri karsilastirir", () => {
    expect(compareRuns({ precision: 1 }, { falseMatchRate: 0 }, dirs)).toEqual([]);
  });
});
