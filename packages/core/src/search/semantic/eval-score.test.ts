import { describe, expect, it } from "vitest";
import { type EvalRow, parseEvalCsv, scoreEval, toEvalCsv } from "./eval-score.ts";

const row = (
  query: string,
  productId: number,
  label: 0 | 1 | 2 | null,
  text: number | null,
  semantic: number | null,
  hybrid: number | null,
): EvalRow => ({ query, productId, label, ranks: { text, semantic, hybrid } });

describe("degerlendirme puani", () => {
  it("ideal siradaki yontem 1, ilgisizi ustte dizen daha dusuk alir", () => {
    const rows = [row("q", 1, 2, 2, 1, 1), row("q", 2, 0, 1, null, 2), row("q", 3, 1, null, 2, 3)];
    const [text, semantic, hybrid] = scoreEval(rows, 3);
    expect(semantic?.ndcg).toBe(1);
    expect(hybrid?.ndcg).toBeGreaterThan(text?.ndcg ?? 1);
    expect(text?.ndcg).toBeLessThan(1);
    expect(text?.irrelevant).toBe(0.5);
    expect(semantic?.precision).toBeCloseTo(0.667, 3);
  });

  it("etiketsiz satir ve ilgilisi olmayan sorgu ortalamaya girmez", () => {
    const rows = [row("a", 1, null, 1, 1, 1), row("b", 2, 0, 1, 1, 1), row("c", 3, 2, 1, null, 1)];
    const scores = scoreEval(rows);
    expect(scores.map((s) => s.queries)).toEqual([1, 1, 1]);
    expect(scores[1]?.ndcg).toBe(0);
  });

  it("CSV gidis-donus: tirnak, virgul ve bos etiket korunur; gecersiz etiket reddedilir", () => {
    const csv = toEvalCsv([
      {
        query: 'laptop, "15.6"',
        productId: 7,
        title: 'Bag, "black"',
        ranks: { text: 1, semantic: null, hybrid: 2 },
        similarity: 0.51234,
      },
    ]);
    const parsed = parseEvalCsv(csv.replace(/,\n$/, ",2\n"));
    expect(parsed).toEqual([row('laptop, "15.6"', 7, 2, 1, null, 2)]);
    expect(parseEvalCsv(csv)[0]?.label).toBeNull();
    expect(() => parseEvalCsv(csv.replace(/,\n$/, ",5\n"))).toThrow("etiket");
  });
});
