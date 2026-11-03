import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findNearDuplicates } from "../../eval/dataset-lint.ts";
import { normalizeQueryText } from "../normalize.ts";
import { NORM_VERSION } from "../normalized-query.ts";
import { foldForMatch } from "../text-match.ts";
import { evaluateNormalization, type NormalizationCase } from "./evaluate.ts";
import {
  buildVocabulary,
  NORMALIZER_RULES_VERSION,
  normalizeQuery,
  phoneticForm,
  phoneticKey,
  queryNormalizationMode,
  renderSuffixed,
  suffixSplits,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const datasets = join(here, "..", "..", "eval", "datasets");
const fixture = JSON.parse(readFileSync(join(here, "vocabulary.fixture.json"), "utf8")) as {
  categories: string[];
  lexicon: { surface: string }[];
};
const { brands } = JSON.parse(
  readFileSync(join(datasets, "query-normalization.brands.json"), "utf8"),
) as { brands: string[] };
const vocabulary = buildVocabulary({
  categories: fixture.categories,
  lexicon: fixture.lexicon,
  brands,
});

function loadCases(split: "dev" | "holdout"): NormalizationCase[] {
  return (
    JSON.parse(readFileSync(join(datasets, `query-normalization.${split}.json`), "utf8")) as {
      cases: NormalizationCase[];
    }
  ).cases;
}

describe("phonetic", () => {
  it("collapses common phonetic spellings of foreign product words to one key", () => {
    expect(phoneticKey("blutut")).toBe(phoneticKey("bluetooth"));
    expect(phoneticKey("ayfon")).toBe(phoneticKey("iphone"));
    expect(phoneticKey("zamzung")).toBe(phoneticKey("samsung"));
    expect(phoneticKey("leptop")).toBe(phoneticKey("laptop"));
    expect(phoneticForm("maus")).toBe(phoneticForm("mouse"));
    expect(phoneticForm("naik")).toBe(phoneticForm("nike"));
  });

  it("keeps clearly different words apart", () => {
    expect(phoneticKey("kablo")).not.toBe(phoneticKey("adaptor"));
    expect(phoneticKey("kilif")).not.toBe(phoneticKey("telefon"));
  });
});

describe("suffixes", () => {
  it("proposes stems with consonant softening reversed", () => {
    expect(suffixSplits("kulakligi")).toContainEqual({
      stem: "kulaklik",
      suffix: "i",
      softened: true,
    });
    expect(suffixSplits("kiliflari")).toContainEqual({
      stem: "kilif",
      suffix: "lari",
      softened: false,
    });
  });

  it("renders suffixes with vowel harmony", () => {
    expect(renderSuffixed("kılıf", "lari", false)).toBe("kılıfları");
    expect(renderSuffixed("koruyucu", "su", false)).toBe("koruyucusu");
    expect(renderSuffixed("kulaklık", "i", true)).toBe("kulaklığı");
    expect(renderSuffixed("ütü", "su", false)).toBe("ütüsü");
  });
});

describe("normalizeQuery contract", () => {
  it("keeps the cache identity and reports versions", () => {
    const result = normalizeQuery("Zamzung  ŞARZ aleti", vocabulary);
    expect(result.raw).toBe("Zamzung  ŞARZ aleti");
    expect(result.norm).toBe(normalizeQueryText("Zamzung  ŞARZ aleti"));
    expect(result.normVersion).toBe(NORM_VERSION);
    expect(result.normalizerVersion).toBe(`${NORMALIZER_RULES_VERSION}+${vocabulary.version}`);
  });

  it("gives spans on the raw text and rebuilds corrected from them", () => {
    const raw = "zamzung şarz aleti";
    const result = normalizeQuery(raw, vocabulary);
    expect(result.corrections.map((c) => [c.from, c.to])).toEqual([
      ["zamzung", "samsung"],
      ["şarz", "şarj"],
    ]);
    for (const correction of result.corrections) {
      expect(raw.slice(correction.span[0], correction.span[1])).toBe(correction.from);
      expect(correction.preservesCodes).toBe(true);
      expect(correction.confidence).toBeGreaterThan(0);
      expect(correction.confidence).toBeLessThanOrEqual(1);
    }
    expect(result.corrections[0]?.kind).toBe("brand");
    expect(result.corrected).toBe("samsung şarj aleti");
  });

  it("returns raw unchanged with no corrections when nothing is wrong", () => {
    const result = normalizeQuery("iPhone 15 Pro Max kılıf", vocabulary);
    expect(result.corrections).toEqual([]);
    expect(result.corrected).toBe("iPhone 15 Pro Max kılıf");
  });

  it("never touches codes, variants, prices or negation", () => {
    for (const raw of [
      "samsng a55 kılıf",
      "rtx 4060 ekran kartı",
      "1000 tl altı kulaklık",
      "zamzung olmasın kulaklık",
      "65w şarj adaptörü",
    ]) {
      const result = normalizeQuery(raw, vocabulary);
      const fromTokens = result.corrections.map((c) => foldForMatch(c.from));
      for (const kept of ["a55", "4060", "1000", "tl", "alti", "olmasin", "65w", "rtx"]) {
        expect(fromTokens).not.toContain(kept);
      }
    }
  });

  it("does not correct a word written in quotes", () => {
    expect(normalizeQuery('"zamzung" kılıf', vocabulary).corrections).toEqual([]);
  });

  it("reports units on number tokens", () => {
    const tokens = normalizeQuery("128 gb usb bellek 65w", vocabulary).tokens;
    expect(tokens[0]?.unit).toEqual({ value: 128, unit: "gb" });
    expect(tokens.at(-1)?.unit).toEqual({ value: 65, unit: "w" });
  });

  it("changes normalizerVersion when the vocabulary changes", () => {
    const other = buildVocabulary({
      categories: fixture.categories,
      lexicon: fixture.lexicon,
      brands: [...brands, "Yenimarka"],
    });
    expect(other.version).not.toBe(vocabulary.version);
  });
});

describe("no-correction guarantees", () => {
  it.each([
    "kablo",
    "kayış",
    "ped",
    "pil",
    "far",
    "ipad kılıfı",
    "gamepad",
    "pilates topu",
    "samsung şarj kablosu",
    "laptop batarya",
    "apple watch kayışı",
    "kulaklık pedi",
    "laptop stand",
    "phone case",
  ])("leaves %s unchanged", (raw) => {
    expect(normalizeQuery(raw, vocabulary).corrections).toEqual([]);
  });

  it("does not map accessory or part words onto device words", () => {
    // Normalizasyon yalniz yazim duzeltir; rol degistiren hedef uretmez.
    const devices = new Set(["telefon", "kulaklik", "saat", "bilgisayar", "laptop"]);
    for (const raw of ["kablo", "kilif", "kayis", "pedi", "batarya", "adaptor", "sarj"]) {
      for (const correction of normalizeQuery(raw, vocabulary).corrections) {
        expect(devices.has(foldForMatch(correction.to))).toBe(false);
      }
    }
  });
});

/** Sabit tohumlu sozde rastgele (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("synthetic regression (seeded)", () => {
  const rand = random(172);
  const words = fixture.categories
    .flatMap((name) => name.toLocaleLowerCase("tr-TR").match(/[\p{L}]+/gu) ?? [])
    .filter((word) => word.length >= 7);
  const unique = [...new Set(words)].sort();
  const sample = Array.from(
    { length: 300 },
    () => unique[Math.floor(rand() * unique.length)] as string,
  );

  it("leaves correctly spelled vocabulary words unchanged", () => {
    const changed = sample.filter(
      (word) => normalizeQuery(word, vocabulary).corrections.length > 0,
    );
    expect(changed).toEqual([]);
  });

  it("fixes single-letter typos in long words and rarely corrects to the wrong word", () => {
    let fixed = 0;
    let wrong = 0;
    for (const word of sample) {
      const at = 1 + Math.floor(rand() * (word.length - 2));
      const typo =
        rand() < 0.5
          ? `${word.slice(0, at)}${word.slice(at + 1)}`
          : `${word.slice(0, at)}${word[at + 1]}${word[at]}${word.slice(at + 2)}`;
      if (vocabulary.get(foldForMatch(typo))) continue;
      const correction = normalizeQuery(typo, vocabulary).corrections[0];
      if (!correction) continue;
      // Belirsiz duzeltmede dogru kelime alternatiflerdeyse arama onu yine dener.
      const targets = [correction.to, ...(correction.alternatives ?? []).map((alt) => alt.to)];
      if (foldForMatch(correction.to) === foldForMatch(word)) fixed += 1;
      else if (!targets.some((target) => foldForMatch(target) === foldForMatch(word))) wrong += 1;
    }
    expect(fixed / sample.length).toBeGreaterThanOrEqual(0.6);
    expect(wrong / sample.length).toBeLessThanOrEqual(0.05);
  });
});

describe("dev set gate (regression)", () => {
  const report = evaluateNormalization(loadCases("dev"), vocabulary, brands, { repeats: 1 });

  it("meets the decision 0172 thresholds on the development set", () => {
    expect(report.normalizationAccuracy).toBeGreaterThanOrEqual(0.85);
    expect(report.wrongCorrectionRate).toBeLessThanOrEqual(0.02);
    expect(report.noCorrectWrongRate).toBeLessThanOrEqual(0.01);
    expect(report.unchangedRate).toBeGreaterThanOrEqual(0.99);
    expect(report.codePreservation).toBe(1);
    expect(report.brandPreservation).toBeGreaterThanOrEqual(0.98);
  });
});

describe("dataset hygiene", () => {
  it("keeps dev and holdout disjoint (no shared query or near-duplicate)", () => {
    const dev = loadCases("dev").map((c) => c.query);
    const holdout = loadCases("holdout").map((c) => c.query);
    const devSet = new Set(dev.map((q) => normalizeQueryText(q)));
    expect(holdout.filter((q) => devSet.has(normalizeQueryText(q)))).toEqual([]);
    const near = findNearDuplicates([...dev, ...holdout], 0.99).filter(
      (pair) => dev.includes(pair.a) !== dev.includes(pair.b),
    );
    expect(near).toEqual([]);
  });

  it("covers every category in both sets with at least 100 queries in total", () => {
    const dev = loadCases("dev");
    const holdout = loadCases("holdout");
    expect(dev.length + holdout.length).toBeGreaterThanOrEqual(200);
    const categories = new Set(dev.map((c) => c.category));
    expect(categories.size).toBe(10);
    for (const category of categories) {
      expect(holdout.some((c) => c.category === category)).toBe(true);
    }
  });
});

describe("mode flag", () => {
  it("defaults to off and accepts only shadow/on", () => {
    expect(queryNormalizationMode({})).toBe("off");
    expect(queryNormalizationMode({ QUERY_NORMALIZATION_MODE: "ON" })).toBe("on");
    expect(queryNormalizationMode({ QUERY_NORMALIZATION_MODE: "shadow" })).toBe("shadow");
    expect(queryNormalizationMode({ QUERY_NORMALIZATION_MODE: "true" })).toBe("off");
  });
});
