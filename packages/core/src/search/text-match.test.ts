import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LexiconEntry } from "./lexicon.ts";
import {
  allowedMisses,
  buildTextSlots,
  candidateCtes,
  candidatePattern,
  candidateStem,
  foldForMatch,
  headTypeFirst,
  MAX_QUERY_TOKENS,
  matchTokens,
  TOKEN_MATCH_THRESHOLD,
} from "./text-match.ts";

const synonym = (surface: string, normalized: string): LexiconEntry => ({
  kind: "synonym",
  surface,
  normalized,
  weight: 1,
});

const LEXICON: LexiconEntry[] = [
  synonym("kablosuz", "kablosuz"),
  synonym("wireless", "kablosuz"),
  synonym("sneaker", "sneaker"),
  synonym("spor ayakkabı", "sneaker"),
  // Esanlam OLMAYAN turler slot uretmez.
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
];

describe("foldForMatch", () => {
  it("folds Turkish to ASCII so 'hali' and 'halı' are the same query", () => {
    expect(foldForMatch("Halı")).toBe("hali");
    expect(foldForMatch("hali")).toBe("hali");
    expect(foldForMatch("ÇOCUK MONTU")).toBe("cocuk montu");
    expect(foldForMatch("IŞIK")).toBe("isik");
  });
});

describe("matchTokens", () => {
  it("keeps order (head noun last), drops 1-char tokens and duplicates", () => {
    expect(matchTokens("kadın omuz çantası")).toEqual(["kadin", "omuz", "cantasi"]);
    expect(matchTokens("a çanta çanta")).toEqual(["canta"]);
    expect(matchTokens("  ")).toEqual([]);
    expect(matchTokens(undefined)).toEqual([]);
  });

  it("caps very long queries but keeps the head noun", () => {
    const words = Array.from({ length: 12 }, (_, i) => `kelime${i}`);
    const tokens = matchTokens(words.join(" "));
    expect(tokens).toHaveLength(MAX_QUERY_TOKENS);
    expect(tokens.at(-1)).toBe("kelime11");
  });
});

describe("buildTextSlots", () => {
  it("expands synonym groups into one slot of alternatives", () => {
    expect(buildTextSlots("kablosuz mouse", LEXICON)).toEqual([
      ["kablosuz", "wireless"],
      ["mouse"],
    ]);
  });

  it("matches multi-word surfaces as a single slot, longest first", () => {
    expect(buildTextSlots("siyah spor ayakkabı", LEXICON)).toEqual([
      ["siyah"],
      ["spor ayakkabi", "sneaker"],
    ]);
  });

  it("ignores non-synonym lexicon kinds (they are filters, not text)", () => {
    expect(buildTextSlots("siyah", LEXICON)).toEqual([["siyah"]]);
  });

  it("returns no slots for empty text", () => {
    expect(buildTextSlots("", LEXICON)).toEqual([]);
  });
});

describe("gate rules", () => {
  it("requires every slot for 1-2 slot queries, allows one missing qualifier for 3+", () => {
    // "telefon kılıfı": bas isim "kılıfı" minder kılıfında eşleşir ama
    // "telefon" eksik -> sonuç yok. 3+ slotta bir niteleyici eksik olabilir.
    expect(allowedMisses(1)).toBe(0);
    expect(allowedMisses(2)).toBe(0);
    expect(allowedMisses(3)).toBe(1);
    expect(allowedMisses(5)).toBe(1);
  });

  it("uses the pg_trgm strict word similarity default so the indexed prefilter agrees", () => {
    expect(TOKEN_MATCH_THRESHOLD).toBe(0.5);
  });
});

describe("aday koku ve regex'i (karar 0129)", () => {
  it("Turkce ek ve unsuz yumusamasini kokun arkasinda birakir", () => {
    expect(candidateStem("cantasi")).toBe("canta");
    expect(candidateStem("canta")).toBe("cant");
    expect(candidateStem("koltuk")).toBe("kolt");
    expect(candidateStem("kulaklik")).toBe("kulakl");
    expect(candidateStem("case")).toBe("case");
    expect(candidateStem("65w")).toBe("65w");
  });

  it("kok kelime basinda aranir; kok bir ekli bicimin onekidir", () => {
    const pattern = candidatePattern("koltugu") as string;
    expect(pattern).toBe(String.raw`\mkoltu`);
    // PostgreSQL `\m` = kelime basi; JS karsiligi `\b`.
    const js = new RegExp(pattern.replace(String.raw`\m`, String.raw`\b`));
    expect(js.test("3'lu koltuk takimi")).toBe(true);
    expect(js.test("yatak odasi")).toBe(false);
    expect(candidatePattern("kilif")).toBe(String.raw`\mkili`);
    expect(candidatePattern("cantasi")).toBe(String.raw`\mcanta`);
  });

  it("cok kelimeli alternatif ardisik kelimelerdir", () => {
    expect(candidatePattern("spor ayakkabi")).toBe(String.raw`\mspor\w*\s+ayakka`);
    // Ilk kelimenin koku kisaltilmis olsa da kelimenin kalani eslesir.
    const pattern = candidatePattern("akilli saat") as string;
    expect(pattern).toBe(String.raw`\makil\w*\s+saat`);
    const js = new RegExp(pattern.replace(String.raw`\m`, String.raw`\b`));
    expect(js.test("garmin akilli saat siyah")).toBe(true);
    expect(js.test("akilli bileklik")).toBe(false);
  });

  it("1-2 harfli kelimede regex yok (trigram uretmez; `<<%` kullanilir)", () => {
    expect(candidatePattern("tv")).toBeNull();
    expect(candidatePattern("4k monitor")).toBeNull();
  });
});

describe("headTypeFirst: urun turu sonda degilse bas isim slotu sona alinir (karar 0214)", () => {
  const slot = (...words: string[]) => words.map((w) => [w]);

  it("dikey supurge hafif -> hafif once, supurge sonda", () => {
    expect(headTypeFirst(slot("dikey", "supurge", "hafif"), "dikey süpürge hafif")).toEqual(
      slot("dikey", "hafif", "supurge"),
    );
  });

  it("tur zaten sondaysa, tur bilinmiyorsa ve tek slotta degismez", () => {
    expect(headTypeFirst(slot("kablosuz", "kulaklik"), "kablosuz kulaklık")).toEqual(
      slot("kablosuz", "kulaklik"),
    );
    expect(headTypeFirst(slot("zorbalux", "hafif"), "zorbalux hafif")).toEqual(
      slot("zorbalux", "hafif"),
    );
    expect(headTypeFirst(slot("supurge"), "süpürge")).toEqual(slot("supurge"));
  });

  it("model ayrintisi (sayi, surum eki) izliyorsa dokunmaz: iphone 17 pro max", () => {
    expect(headTypeFirst(slot("iphone", "17", "pro", "max"), "iphone 17 pro max")).toEqual(
      slot("iphone", "17", "pro", "max"),
    );
  });

  it("es anlamli slot tasinirken alternatifleri korunur", () => {
    const slots = [["dikey"], ["supurge", "vacuum"], ["hafif", "light"]];
    expect(headTypeFirst(slots, "dikey süpürge hafif")).toEqual([
      ["dikey"],
      ["hafif", "light"],
      ["supurge", "vacuum"],
    ]);
  });
});

describe("candidateCtes: slot kosullari dagitilir (karar 0215)", () => {
  const render = (slots: string[][]) => new PgDialect().sqlToQuery(candidateCtes(slots, {})).sql;
  const branches = (sqlText: string) => (sqlText.match(/SELECT p\.id,/g) ?? []).length;

  it("2 slot: her alternatif birlesimi ayri dal, her dalda BUTUN slotlar indeks kosulu", () => {
    const text = render([
      ["kablosuz", "wireless"],
      ["kulaklik", "headphone", "earbuds"],
    ]);
    // 2 x 3 birlesim x 2 bolum
    expect(branches(text)).toBe(12);
    expect(text).not.toMatch(/\) OR \(.*\) AND \(/);
  });

  it("pricedOnly: yalniz fiyatli bolum (offer_count > 0), yurt disi bolumu yok (karar 0216)", () => {
    const text = new PgDialect().sqlToQuery(
      candidateCtes([["kadin"], ["omuz"], ["canta"]], {}, { pricedOnly: true }),
    ).sql;
    expect(text).toContain("p.offer_count > 0");
    expect(text).not.toContain("p.offer_count = 0");
    expect(branches(text)).toBe(1 + 2);
  });

  it("tek slot ve 3+ slot dagitilmaz (3+ slotta dagitma olculdu, yarar saglamadi)", () => {
    expect(branches(render([["kulaklik", "headphone"]]))).toBe(2);
    // 3 slot: bas isim ailesi n-1 = 2 dal + siki 1 dal, bolum basina; alternatif sayisindan bagimsiz
    const three = render([
      ["a1x", "a2x", "a3x"],
      ["bb1", "bb2"],
      ["cc1", "cc2", "cc3", "cc4"],
    ]);
    expect(branches(three)).toBe(2 * (1 + 2));
  });

  it("birlesim sayisi sinirini asan 2 slotta en genis slot VEYA'li tek kosula katlanir", () => {
    const wide = Array.from(
      { length: 30 },
      (_, i) => `kelime${String.fromCharCode(97 + (i % 26))}${i}`,
    );
    const text = render([wide, ["kulaklik", "headphone"]]);
    expect(branches(text)).toBe(2 * 2);
  });
});
