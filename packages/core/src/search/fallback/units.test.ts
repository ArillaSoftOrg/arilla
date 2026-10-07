import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeQuery, wordsOf } from "./analyze.ts";
import { editDistance, gradeItem, wordSimilarity } from "./grade.ts";
import { constraintLadder, planFallbackStages, tokenLadder } from "./stages.ts";
import { parsed } from "./test-catalog.ts";

const analyze = (text: string) => analyzeQuery(parsed(text));

describe("query analysis", () => {
  it("keeps model-defining tokens and classifies them", () => {
    const { tokens } = analyze("iPhone 17 PRO Max");
    expect(tokens.map((token) => [token.value, token.kind])).toEqual([
      ["iphone", "word"],
      ["17", "model"],
      ["pro", "variant"],
      ["max", "variant"],
    ]);
  });

  it("folds Turkish characters and punctuation", () => {
    expect(wordsOf("Çanta, ŞIK! İstanbul")).toEqual(["canta", "sik", "istanbul"]);
  });

  it("glues number + unit, keeps single digits", () => {
    expect(wordsOf("iPhone 15 128 GB")).toEqual(["iphone", "15", "128gb"]);
    expect(analyze("playstation 5").tokens.map((t) => t.value)).toEqual(["playstation", "5"]);
    expect(wordsOf("Galaxy S24 256GB")).toEqual(["galaxy", "s24", "256gb"]);
  });
});

describe("grading", () => {
  const item = (title: string) => ({ title, brandName: "Apple" });
  const tokens = analyze("iphone 17 pro max").tokens;

  it("model mismatch is never exact", () => {
    expect(gradeItem(tokens, item("iPhone 16 Pro Max")).tier).toBe("related");
    expect(gradeItem(tokens, item("iPhone 16 Pro Max")).modelMismatch).toBe(true);
    expect(gradeItem(tokens, item("iPhone 17 Pro Max 256GB")).tier).toBe("exact");
  });

  it("missing surname-like variant is close, not exact", () => {
    expect(gradeItem(tokens, item("iPhone 17 Pro")).tier).toBe("close");
  });

  it("unrelated product grades none", () => {
    expect(gradeItem(tokens, { title: "Nike Spor Çanta", brandName: "Nike" }).tier).toBe("none");
  });

  it("fuzzy and prefix similarity", () => {
    expect(editDistance("airpdos", "airpods")).toBe(1);
    expect(wordSimilarity("airpod", ["airpods"], "word")).toBeGreaterThan(0.8);
    expect(wordSimilarity("ayakkabisi", ["ayakkabi"], "word")).toBeGreaterThan(0.8);
    // Sayi bulanik eslesmez: 17 != 16.
    expect(wordSimilarity("17", ["16"], "model")).toBe(0);
    // Alt dize tuzagi (docs/decisions/0029): "hali" != "halkali".
    expect(wordSimilarity("hali", ["halkali"], "word")).toBe(0);
  });
});

describe("stage planning", () => {
  it("drops variants from the right, then the model code", () => {
    const steps = tokenLadder(analyze("iphone 17 pro max").tokens);
    expect(steps.map((step) => step.tokens.map((t) => t.value).join(" "))).toEqual([
      "iphone 17 pro",
      "iphone 17",
      "iphone",
    ]);
  });

  it("never relaxes price, brand exclusion or the last anchor; stops below root category", () => {
    const steps = constraintLadder(
      {
        color: ["blue"],
        size_norm: "42",
        category_path: "moda/ayakkabi/kosu",
        price_max: 500_000,
        brand_include: ["nike"],
      },
      [],
    );
    expect(steps.map((step) => step.relaxed)).toEqual([
      ["color"],
      ["color", "size"],
      ["color", "size", "category"],
    ]);
    expect(steps.at(-1)?.filters).toMatchObject({
      category_path: "moda/ayakkabi",
      price_max: 500_000,
      brand_include: ["nike"],
    });
  });

  it("does not produce a step that would leave the query without an anchor", () => {
    expect(constraintLadder({ color: ["red"] }, [])).toEqual([]);
  });

  it("caps the number of provider calls", () => {
    const { tokens } = analyze("iphone 17 pro max 256gb");
    const stages = planFallbackStages({
      text: "x",
      tokens,
      baseSlots: tokens.map((t) => [t.value]),
      filters: { color: ["black"], size_norm: "42", category_path: "a/b/c/d/e" },
      sort: "balanced",
      hasAliasExpansion: true,
      canFuzzy: true,
      limit: 48,
    });
    expect(stages.length).toBeLessThanOrEqual(10);
    expect(stages.every((stage) => stage.query.sort === "balanced")).toBe(true);
  });
});

describe("no model call (CLAUDE.md kural 1)", () => {
  it("the fallback sources import no LLM, provider SDK or HTTP client", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const forbidden = /(llm|gemini|@google|openai|anthropic|embedding|fetch\s*\()/i;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "test-catalog.ts")
        continue;
      const source = readFileSync(join(dir, file), "utf8");
      const imports = source.split("\n").filter((line) => /^\s*(import|export)\b.*from/.test(line));
      for (const line of imports) expect(line, `${file}: ${line}`).not.toMatch(forbidden);
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/GEMINI|getLlmClient/);
    }
  });
});
