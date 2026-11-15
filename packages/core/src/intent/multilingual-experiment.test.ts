/**
 * Dil bagimsiz sorgu anlama sozlesmesi testleri (E4b C+ v3). Ornek diller (tr, en, de, pt, ja) yalniz
 * baslangic ornekleridir; SENTETIK testler gercek arama kalitesi kaniti DEGILDIR.
 */
import { describe, expect, it } from "vitest";
import { foldForMatch } from "../search/text-match.ts";
import {
  buildMultilingualInput,
  buildMultilingualInstructions,
  buildMultilingualSchema,
  buildQueryUnderstanding,
  DEFAULT_MULTILINGUAL_CONFIG,
  E4B_CPLUS_RUN_CONFIG,
  guessTitleLanguage,
  type MultilingualFields,
  multilingualContractHash,
  parseMultilingualFields,
} from "./multilingual-experiment.ts";

const fields = (over: Partial<MultilingualFields> = {}): MultilingualFields => ({
  detected_language: { tag: "tr", confidence: "high" },
  search_queries: [],
  alternative_search_terms: [],
  excluded_features: [],
  ...over,
});

describe("sozlesme: hicbir dil zorunlu degil", () => {
  it("varsayilan sozlesme yazimi istege baglar; kosu sozlesmesi ayri tutulur", () => {
    const v3 = buildMultilingualInstructions(DEFAULT_MULTILINGUAL_CONFIG);
    const run = buildMultilingualInstructions(E4B_CPLUS_RUN_CONFIG);
    expect(v3).toContain("İSTEĞE BAĞLI");
    expect(v3).not.toContain("HER dil için");
    expect(run).toContain("HER dil için");
    expect(multilingualContractHash(DEFAULT_MULTILINGUAL_CONFIG)).not.toBe(
      multilingualContractHash(E4B_CPLUS_RUN_CONFIG),
    );
  });

  it("katalog dilleri yapilandirmadir: yeni dil sema/istem kodunu degistirmeden eklenir", () => {
    const config = { ...DEFAULT_MULTILINGUAL_CONFIG, catalogLanguages: ["en", "tr", "de", "ar"] };
    const schema = buildMultilingualSchema(config) as {
      properties: { search_queries: { maxItems: number; minItems?: number } };
    };
    expect(schema.properties.search_queries.maxItems).toBe(4);
    expect(schema.properties.search_queries.minItems).toBeUndefined();
    expect(JSON.parse(buildMultilingualInput("Tastatur", config)).catalog_languages).toEqual([
      "en",
      "tr",
      "de",
      "ar",
    ]);
    expect(buildMultilingualInstructions(config)).toContain("en, tr, de, ar");
  });

  it("model ciktisi bicim disiyse null (guvenli geri dusus: ham sorgu)", () => {
    expect(parseMultilingualFields(null)).toBeNull();
    expect(parseMultilingualFields({ detected_language: { tag: "tr" } })).toBeNull();
    const ok = parseMultilingualFields({
      detected_language: { tag: "pt-BR", confidence: "medium" },
      search_queries: [{ language: "en", text: "laptop backpack" }],
    });
    expect(ok?.detected_language.tag).toBe("pt-BR");
    expect(ok?.excluded_features).toEqual([]);
  });
});

describe("QueryUnderstanding (qu-1)", () => {
  const base = {
    productType: { value: "klavye", source: "explicit", evidence: "klavye" },
    role: "main",
    exactSpecs: [],
    verifiedExcluded: [],
    fold: foldForMatch,
  };

  it("Gemini basarisiz ya da kapali: ham sorgu korunur, plan raw_only", () => {
    const qu = buildQueryUnderstanding({
      ...base,
      original: "kablolu klavye",
      fields: null,
      verdicts: [],
    });
    expect(qu).toMatchObject({
      original: "kablolu klavye",
      detectedLanguage: null,
      plan: "raw_only",
    });
  });

  it("alternatif yok (bos liste) gecerli ve guvenli durumdur", () => {
    const qu = buildQueryUnderstanding({
      ...base,
      original: "Lötkolben",
      fields: fields({ detected_language: { tag: "de", confidence: "high" } }),
      verdicts: [],
    });
    expect(qu.plan).toBe("raw_only");
    expect(qu.detectedLanguage?.tag).toBe("de");
  });

  it("kanitsiz urun turu model_only; reddedilen alternatif plani degistirmez", () => {
    const qu = buildQueryUnderstanding({
      ...base,
      original: "anime seven arkadaşıma hediye",
      productType: { value: "kitap", source: "inferred" },
      fields: fields(),
      verdicts: [
        {
          rewrite: { language: "en", text: "anime book" },
          accepted: false,
          reason: "product_type_unverified",
        },
      ],
    });
    expect(qu.productType?.status).toBe("model_only");
    expect(qu.plan).toBe("raw_only");
    expect(qu.alternatives[0]).toMatchObject({ language: "en", accepted: false });
  });

  it("dislama kaniti ham metinde dogrulanmissa verified, kaniti uyusmazsa rejected", () => {
    const qu = buildQueryUnderstanding({
      ...base,
      original: "clavier sans bluetooth",
      verifiedExcluded: ["bluetooth"],
      fields: fields({
        detected_language: { tag: "fr", confidence: "high" },
        excluded_features: [
          { language: "en", text: "Bluetooth", evidence: "sans bluetooth" },
          { language: "en", text: "rgb", evidence: "sans rgb" },
        ],
      }),
      verdicts: [
        {
          rewrite: { language: "tr", text: "bluetooth olmayan klavye" },
          accepted: true,
          reason: null,
        },
      ],
    });
    expect(qu.exclusions.map((e) => e.status)).toEqual(["verified", "rejected"]);
    expect(qu.plan).toBe("raw_plus_alternatives");
  });
});

describe("urun basligi dili varsayilmaz", () => {
  it("kisa ya da model kodlu baslikta dil belirsiz kalir", () => {
    expect(guessTitleLanguage("DDR5 32GB").tag).toBe("und");
    expect(guessTitleLanguage("Kablolu Oyuncu Klavyesi ve Mouse Seti için").tag).toBe("tr");
  });
});
