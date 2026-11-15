import { describe, expect, it } from "vitest";
import { PILOT_CASES } from "./chat-answer-pilot-cases.ts";
import {
  type AuditFile,
  applyReviewCsv,
  buildReviewItems,
  parseCsv,
  renderReviewCsv,
  renderReviewMarkdown,
} from "./chat-answer-review-pack.ts";

const first = PILOT_CASES.find((c) => c.expect === "should_answer");
if (!first) throw new Error("no case");

function record(over: Record<string, unknown> = {}) {
  return {
    id: first?.id as string,
    caseId: first?.id as string,
    type: first?.type as string,
    category: first?.category as string,
    expect: first?.expect as string,
    query: first?.query as string,
    question: first?.question as string,
    action: "answer",
    validated: true,
    shownText: 'Birinci satır,\n"tırnaklı" ikinci satır',
    paragraphs: [],
    rawParagraphs: [],
    autoFlags: [],
    review: { verdict: null, notes: "" },
    ...over,
  };
}

const audit = (records: unknown[]): AuditFile => ({
  meta: { runId: "r1", model: "m" },
  records: records as AuditFile["records"],
});

describe("buildReviewItems", () => {
  it("includes only validated answer actions and leaves the human decision empty", () => {
    const items = buildReviewItems(
      audit([
        record(),
        record({ validated: false }),
        record({ action: "search", validated: null }),
      ]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.human).toEqual({ verdict: null, notes: "" });
    expect(items[0]?.facts.length).toBeGreaterThan(0);
    expect(items[0]?.auto.currentValidator).toBe("rejected"); // boş ham paragraf: otomatik de geçmez
  });

  it("fails loudly on an unknown case instead of guessing facts", () => {
    expect(() => buildReviewItems(audit([record({ caseId: "yok-99", id: "yok-99" })]))).toThrow(
      /unknown case/,
    );
  });
});

describe("render", () => {
  const items = buildReviewItems(audit([record()]));

  it("markdown states that nothing in it is a human decision and shows the fact table", () => {
    const md = renderReviewMarkdown(items, { runId: "r1", model: "m" });
    expect(md).toContain("hiçbir insan kararı yoktur");
    expect(md).toContain("| # | Başlık | Marka | Mağaza | Fiyat (TL) | Teklif |");
    expect(md).toContain("İnsan kararı: [ ] correct");
  });

  it("csv has empty human columns and survives a parse round trip with quotes and newlines", () => {
    const csv = renderReviewCsv(items);
    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    const row = rows[1] ?? [];
    expect(row[header.indexOf("human_verdict")]).toBe("");
    expect(row[header.indexOf("human_notes")]).toBe("");
    // satır sonu tek satıra indirilir, tırnak korunur
    expect(row[header.indexOf("shown_text")]).toBe('Birinci satır, "tırnaklı" ikinci satır');
  });
});

describe("applyReviewCsv", () => {
  const csvOf = (rows: string[]) => ["case_id,human_verdict,human_notes", ...rows].join("\n");

  it("writes only allowed verdicts and keeps blanks blank (no invented decisions)", () => {
    const file = audit([record()]);
    const id = first?.id as string;
    const report = applyReviewCsv(file, csvOf([`${id},correct,"tamam, doğru"`]));
    expect(report).toEqual({ applied: 1, blank: 0, errors: [] });
    expect(file.records[0]?.review).toEqual({ verdict: "correct", notes: "tamam, doğru" });

    const blankFile = audit([record()]);
    const blank = applyReviewCsv(blankFile, csvOf([`${id},,`]));
    expect(blank).toEqual({ applied: 0, blank: 1, errors: [] });
    expect(blankFile.records[0]?.review.verdict).toBeNull();
  });

  it("rejects invalid verdicts and unknown cases without applying them", () => {
    const file = audit([record()]);
    const id = first?.id as string;
    const report = applyReviewCsv(file, csvOf([`${id},iyi,`, "yok-1,correct,"]));
    expect(report.applied).toBe(0);
    expect(report.errors).toHaveLength(2);
    expect(file.records[0]?.review.verdict).toBeNull();
  });

  it("requires the expected header", () => {
    const report = applyReviewCsv(audit([record()]), "a,b\n1,2");
    expect(report.errors[0]).toMatch(/başlığında/);
  });
});
