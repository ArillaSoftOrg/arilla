import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LABEL_CSV_HEADER, mergeHumanLabels, parseCsv, parseLabelCsv } from "./labels-csv.ts";
import { evaluateMultilingual } from "./metrics.ts";
import {
  type CandidateItem,
  type Dataset,
  humanLabeled,
  languagePair,
  validateDataset,
} from "./schema.ts";

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8")) as T;
}

const csvText = readFileSync(new URL("./data/labels-template.csv", import.meta.url), "utf8");

function dataset(): Dataset {
  return {
    languages: load<{ languages: Dataset["languages"] }>("languages.json").languages,
    intents: load<{ intents: Dataset["intents"] }>("queries.json").intents,
    queries: load<{ queries: Dataset["queries"] }>("queries.json").queries,
    items: load<{ items: Dataset["items"] }>("candidates.json").items,
  };
}

function item(overrides: Partial<CandidateItem>): CandidateItem {
  return {
    item_id: "T-1",
    query_id: "Q-tr",
    intent_id: "I",
    query_lang: "tr",
    doc_id: "d1",
    doc_lang: "en",
    slice: 1,
    label_source: "human",
    label: 3,
    ai_preliminary_label: null,
    annotator: "a",
    ...overrides,
  };
}

describe("shipped dataset", () => {
  const data = dataset();

  it("passes schema validation", () => {
    expect(validateDataset(data)).toEqual([]);
  });

  it("has no human labels yet: nothing may claim to be human-labeled", () => {
    expect(data.items.some((i) => i.label_source === "human")).toBe(false);
    expect(data.items.every((i) => i.label === null)).toBe(true);
    expect(humanLabeled(data.items)).toHaveLength(0);
  });

  it("marks AI preliminary labels separately and never as label", () => {
    const ai = data.items.filter((i) => i.label_source === "ai_preliminary");
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((i) => i.label === null && i.ai_preliminary_label !== null)).toBe(true);
  });

  it("is balanced across query languages and every intent has all three", () => {
    const perLang = new Map<string, number>();
    for (const i of data.items) perLang.set(i.query_lang, (perLang.get(i.query_lang) ?? 0) + 1);
    expect([...perLang.keys()].sort()).toEqual(["de", "en", "tr"]);
    expect(new Set(perLang.values()).size).toBe(1);
    expect(data.items.length).toBeGreaterThanOrEqual(400);
    expect(data.items.length).toBeLessThanOrEqual(600);
    for (const intent of data.intents) {
      const langs = data.queries
        .filter((q) => q.intent_id === intent.intent_id)
        .map((q) => q.query_lang);
      expect(langs.sort()).toEqual(["de", "en", "tr"]);
    }
  });

  it("marks every non-original translation as an unverified draft", () => {
    for (const q of data.queries) {
      if (q.text_source !== "original") expect(q.translation_status).toBe("draft_unverified");
    }
  });

  it("csv template is blind, BOM-prefixed, and one row per candidate", () => {
    expect(csvText.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csvText);
    expect(rows[0]).toEqual([...LABEL_CSV_HEADER]);
    expect(rows).toHaveLength(data.items.length + 1);
    const parsed = parseLabelCsv(csvText);
    expect(parsed.every((r) => r.label === "" && r.annotator === "")).toBe(true);
    expect(parsed.map((r) => r.item_id)).toEqual(data.items.map((i) => i.item_id));
    // blindness: no provenance/system columns, no AI columns
    const header = rows[0]?.join(",") ?? "";
    expect(header).not.toMatch(/system|lexical|dense|hybrid|rank|ai_|pool|product_id/i);
  });
});

describe("validateDataset", () => {
  const base = (): Dataset => ({
    languages: [
      { tag: "tr", name: "Turkish", status: "active" },
      { tag: "en", name: "English", status: "active" },
    ],
    intents: [
      {
        intent_id: "I",
        intent_type: "category",
        description: "x",
        origin: "t",
        origin_query_ids: [],
        expected_hint: { title_regex: "x", flags: "i", note: "" },
        slice: 1,
      },
    ],
    queries: [
      {
        query_id: "Q-tr",
        intent_id: "I",
        query_lang: "tr",
        text: "a",
        text_source: "original",
        translation_status: "source_text",
      },
    ],
    items: [item({})],
  });

  it("accepts a minimal valid dataset", () => {
    expect(validateDataset(base())).toEqual([]);
  });

  it("rejects a human record without annotator", () => {
    const d = base();
    d.items = [item({ annotator: undefined })];
    expect(validateDataset(d).join()).toMatch(/annotator/);
  });

  it("rejects a label on a non-human record", () => {
    const d = base();
    d.items = [item({ label_source: "ai_preliminary", label: 2, ai_preliminary_label: 2 })];
    expect(validateDataset(d).join()).toMatch(/human olmayan/);
  });

  it("rejects ai_preliminary without its value and none with an AI value", () => {
    const d = base();
    d.items = [
      item({ item_id: "a", label_source: "ai_preliminary", label: null }),
      item({
        item_id: "b",
        doc_id: "d2",
        label_source: "none",
        label: null,
        ai_preliminary_label: 1,
      }),
    ];
    const errors = validateDataset(d).join();
    expect(errors).toMatch(/item a/);
    expect(errors).toMatch(/item b/);
  });

  it("rejects unregistered languages but accepts a new language added as data only", () => {
    const d = base();
    d.queries.push({
      query_id: "Q-fr",
      intent_id: "I",
      query_lang: "fr",
      text: "b",
      text_source: "manual_draft",
      translation_status: "draft_unverified",
    });
    expect(validateDataset(d).join()).toMatch(/fr/);
    d.languages.push({ tag: "fr", name: "French", status: "active" });
    expect(validateDataset(d)).toEqual([]);
  });

  it("rejects malformed language tags and duplicate pairs", () => {
    const d = base();
    d.languages.push({ tag: "Turkish!", name: "x", status: "open" });
    d.items.push(item({ item_id: "T-2" }));
    const errors = validateDataset(d).join();
    expect(errors).toMatch(/gecersiz Turkish!/);
    expect(errors).toMatch(/tekrar/);
  });
});

describe("mergeHumanLabels", () => {
  const items: CandidateItem[] = [
    item({ item_id: "A", doc_id: "d1", label_source: "none", label: null, annotator: undefined }),
    item({
      item_id: "B",
      doc_id: "d2",
      label_source: "ai_preliminary",
      label: null,
      ai_preliminary_label: 3,
      annotator: undefined,
    }),
  ];
  const rows = (a: string, b: string, annotator = "yusuf") => [
    { item_id: "A", query_id: "Q-tr", label: a, annotator, notes: "" },
    { item_id: "B", query_id: "Q-tr", label: b, annotator, notes: "" },
  ];

  it("turns filled rows into human labels and keeps empty rows untouched", () => {
    const r = mergeHumanLabels(items, rows("2", ""));
    expect(r.errors).toEqual([]);
    expect(r.applied).toBe(1);
    expect(r.items[0]).toMatchObject({ label_source: "human", label: 2, annotator: "yusuf" });
    expect(r.items[1]).toMatchObject({ label_source: "ai_preliminary", label: null });
  });

  it("rejects out-of-scale labels, missing annotator, tampered query ids", () => {
    expect(mergeHumanLabels(items, rows("4", "x")).errors).toHaveLength(2);
    expect(mergeHumanLabels(items, rows("1", "", "")).errors.join()).toMatch(/annotator/);
    const tampered = [{ item_id: "A", query_id: "Q-de", label: "1", annotator: "a", notes: "" }];
    expect(mergeHumanLabels(items, tampered).errors.join()).toMatch(/query_id/);
    expect(mergeHumanLabels(items, rows("1", "")).items[0]?.label_source).toBe("human");
  });

  it("parses quoted multi-line cells", () => {
    expect(parseCsv('a,b\r\n"x, ""y""\nz",2\r\n')).toEqual([
      ["a", "b"],
      ['x, "y"\nz', "2"],
    ]);
  });
});

describe("evaluateMultilingual", () => {
  // Query Q-tr: d1 en=3, d2 en=0, d3 tr=2
  const human = (
    id: string,
    doc: string,
    lang: string,
    label: 0 | 1 | 2 | 3,
    q = "Q-tr",
    ql = "tr",
  ) => item({ item_id: id, query_id: q, query_lang: ql, doc_id: doc, doc_lang: lang, label });
  const items: CandidateItem[] = [
    human("1", "d1", "en", 3),
    human("2", "d2", "en", 0),
    human("3", "d3", "tr", 2),
  ];

  it("computes nDCG@10 and P@10 overall and by language pair", () => {
    const [report] = evaluateMultilingual(items, [
      { system: "s", query_id: "Q-tr", doc_ids: ["d1", "d3", "d2"] },
    ]);
    expect(report?.overall.queries).toBe(1);
    expect(report?.overall.ndcg).toBe(1);
    expect(report?.overall.precision).toBe(0.2);
    expect(Object.keys(report?.byPair ?? {}).sort()).toEqual([languagePair("tr", "en"), "tr>tr"]);
    expect(report?.byPair["tr>en"]?.ndcg).toBe(1);
    expect(report?.byQueryLang.tr?.queries).toBe(1);
  });

  it("penalises a bad order and counts unjudged docs as non-relevant", () => {
    const [report] = evaluateMultilingual(items, [
      { system: "s", query_id: "Q-tr", doc_ids: ["x1", "d2", "d1"] },
    ]);
    expect(report?.overall.ndcg).toBeLessThan(0.5);
    expect(report?.overall.judgedFraction).toBe(0.2);
  });

  it("ignores AI-preliminary and unlabeled records entirely", () => {
    const unlabeled = item({
      item_id: "9",
      doc_id: "dX",
      label_source: "none",
      label: null,
      annotator: undefined,
    });
    const withAi: CandidateItem = {
      ...unlabeled,
      label_source: "ai_preliminary",
      ai_preliminary_label: 3,
    };
    const runs = [{ system: "s", query_id: "Q-tr", doc_ids: ["dX", "d1"] }];
    const clean = evaluateMultilingual([...items, unlabeled], runs);
    const dirty = evaluateMultilingual([...items, withAi], runs);
    expect(dirty).toEqual(clean);
  });

  it("skips queries with no human labels (only AI) instead of scoring them", () => {
    const onlyAi: CandidateItem[] = [
      item({
        label_source: "ai_preliminary",
        label: null,
        ai_preliminary_label: 3,
        annotator: undefined,
      }),
    ];
    const [report] = evaluateMultilingual(onlyAi, [
      { system: "s", query_id: "Q-tr", doc_ids: ["d1"] },
    ]);
    expect(report?.overall.queries).toBe(0);
    expect(report?.skipped.noHumanLabels).toBe(1);
  });

  it("skips queries whose human labels contain no relevant doc", () => {
    const zero = [human("1", "d1", "en", 0), human("2", "d2", "en", 0)];
    const [report] = evaluateMultilingual(zero, [
      { system: "s", query_id: "Q-tr", doc_ids: ["d1"] },
    ]);
    expect(report?.overall.queries).toBe(0);
    expect(report?.skipped.noRelevant).toBe(1);
  });

  it("separates systems and query languages without code changes for new languages", () => {
    const multi = [
      ...items,
      human("4", "d1", "en", 3, "Q-fr", "fr"),
      human("5", "d2", "en", 0, "Q-fr", "fr"),
    ];
    const reports = evaluateMultilingual(multi, [
      { system: "b", query_id: "Q-tr", doc_ids: ["d1"] },
      { system: "a", query_id: "Q-fr", doc_ids: ["d2", "d1"] },
    ]);
    expect(reports.map((r) => r.system)).toEqual(["a", "b"]);
    expect(reports[0]?.byPair["fr>en"]?.queries).toBe(1);
    expect(reports[0]?.byPair["fr>en"]?.ndcg).toBeLessThan(1);
  });
});
