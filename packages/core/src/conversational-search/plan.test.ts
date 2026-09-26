import { describe, expect, it } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY, type ExtractContext } from "../clarification/index.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { budgetLabel, type ConversationPlan, planConversation, replyToInput } from "./plan.ts";

const LEXICON: readonly LexiconEntry[] = [
  { kind: "color", surface: "siyah", normalized: "black", weight: 1 },
  { kind: "brand", surface: "nike", normalized: "nike", weight: 1 },
];

const CONTEXT: ExtractContext = { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon: LEXICON };

function plan(query: string, steps: readonly string[] = [], reply?: string): ConversationPlan {
  return planConversation({ query, steps, reply }, CONTEXT);
}

type Conversation = Extract<ConversationPlan, { mode: "conversation" }>;

function conversation(result: ConversationPlan): Conversation {
  if (result.mode !== "conversation")
    throw new Error(`conversation bekleniyordu: ${result.reason}`);
  return result;
}

/** Arayuzun yaptigi gibi: gosterilen secenegin adimlariyla bir sonraki istek. */
function choose(current: Conversation, optionId: string): Conversation {
  const option = current.question?.options.find((o) => o.id === optionId);
  if (!option) throw new Error(`"${optionId}" secenegi gosterilmedi`);
  return conversation(plan(current.query, option.steps));
}

function constraints(current: Conversation): string[] {
  return current.constraints.map((chip) => chip.label);
}

function context(current: Conversation): string[] {
  return current.context.map((chip) => chip.label);
}

describe("planConversation: demo senaryolari", () => {
  it("A) kask -> soru -> kapalı -> en fazla bir soru daha, sonra arama", () => {
    const first = conversation(plan("kask"));
    expect(first.action).toBe("clarify");
    expect(first.question?.text).toBe("Nasıl bir kask arıyorsun?");
    // Secenekler taksonomiden gelir; arayuz uydurmaz.
    expect(first.question?.options.map((o) => o.id)).toEqual([
      "full_face",
      "open_face",
      "half",
      "modular",
      "off_road",
    ]);
    // Soru acikken de sonuclar icin bir sorgu vardir (sonuclar bekletilmez).
    expect(first.queryObject.unparsed).toBe("kask");

    const second = choose(first, "full_face");
    expect(constraints(second)).toEqual(["Kapalı (full face)"]);
    expect(second.queryObject.unparsed).toBe("kapalı kask");
    expect(second.question?.id).toBe("use_case");

    const third = choose(second, "city");
    expect(third.action).toBe("search");
    expect(third.question).toBeNull();
    // "Şehir içi" aramaya girmez: filtre degil, baglam.
    expect(constraints(third)).toEqual(["Kapalı (full face)"]);
    expect(context(third)).toEqual(["Şehir içi"]);
    expect(third.queryObject.unparsed).toBe("kapalı kask");
  });

  it("B) kask -> kapalı -> 'aslında modüler olsun': tek deger kalir", () => {
    const answered = choose(conversation(plan("kask")), "full_face");
    const corrected = conversation(plan("kask", answered.steps, "aslında modüler olsun"));
    expect(corrected.reply?.outcome).toBe("applied");
    expect(constraints(corrected)).toEqual(["Modüler (çene açılır)"]);
    expect(corrected.queryObject.unparsed).toBe("çene açılır kask");
    expect(corrected.steps.at(-1)).toBe("t~aslında modüler olsun");
    const replayed = conversation(plan("kask", corrected.steps));
    expect(constraints(replayed)).toEqual(constraints(corrected));
  });

  it("C) hediye -> anne -> ilgi -> butce: kisit ve baglam ayrisir", () => {
    const first = conversation(plan("hediye arıyorum"));
    expect(first.question?.id).toBe("recipient");
    const second = conversation(plan(first.query, first.steps, "annem için"));
    expect(second.reply?.outcome).toBe("applied");
    // Alici katalogu filtrelemez; filtre gibi gosterilmez.
    expect(constraints(second)).toEqual([]);
    expect(context(second)).toEqual(["Annem"]);

    const third = choose(second, "beauty");
    const fourth = third.action === "clarify" ? choose(third, "500_1000") : third;
    expect(fourth.action).toBe("search");
    expect(fourth.queryObject.filters.category_path).toBe("saglik-kozmetik");
    expect(context(fourth)).toEqual(["Annem"]);
    expect(constraints(fourth)).toEqual(
      expect.arrayContaining(["Bakım ve kozmetik", "500 TL – 1.000 TL"]),
    );
    expect(constraints(fourth)).not.toContain("Annem");
  });

  it("D) '1000 liraya anneme hediye': bilinen alici ve butce tekrar sorulmaz", () => {
    const first = conversation(plan("1000 liraya anneme hediye"));
    expect(first.question?.id).not.toBe("recipient");
    expect(first.question?.id).not.toBe("budget");
    expect(context(first)).toContain("Annem");
    expect(constraints(first)).toContain("En fazla 1.000 TL");
    if (first.action === "clarify") expect(first.question?.id).toBe("interest");
  });

  it("E) iphone 16 kılıfı: konusma yok, dogrudan arama", () => {
    expect(plan("iphone 16 kılıfı")).toMatchObject({ mode: "conventional", reason: "no_domain" });
  });

  it("F) siyah erkek koşu ayakkabısı: soru sorulmadan aranir", () => {
    const result = conversation(plan("siyah erkek koşu ayakkabısı"));
    expect(result.action).toBe("search");
    expect(constraints(result)).toEqual(expect.arrayContaining(["Koşu", "Erkek", "Siyah"]));
  });

  it("G) ayakkabı: netlestirme sorusu", () => {
    const result = conversation(plan("ayakkabı"));
    expect(result.action).toBe("clarify");
    expect(result.question?.id).toBe("shoe_type");
  });

  it("H) masa lambası: dogrudan arama", () => {
    expect(plan("masa lambası").mode).toBe("conventional");
  });

  it("I) kask -> 'Emin değilim' -> hemen genis arama; yazili 'fark etmez' de ayni", () => {
    const first = conversation(plan("kask"));
    const skipped = conversation(plan("kask", first.question?.skip.steps ?? []));
    expect(skipped.action).toBe("search");
    expect(skipped.question).toBeNull();
    expect(skipped.queryObject.unparsed).toBe("kask");
    expect(skipped.constraints).toEqual([]);

    const typed = conversation(plan("kask", [], "fark etmez"));
    expect(typed.steps).toEqual(["s~helmet_type"]);
    expect(typed.action).toBe("search");
  });

  it("atlama onceki cevaplari korur: kapalı -> 'Fark etmez' -> arama, kapalı kalir", () => {
    const answered = choose(conversation(plan("kask")), "full_face");
    const skipped = conversation(plan("kask", answered.question?.skip.steps ?? []));
    expect(skipped.action).toBe("search");
    expect(constraints(skipped)).toEqual(["Kapalı (full face)"]);
  });
});

describe("serbest yanit: asla sessizce yutulmaz", () => {
  it("'5 bin lirayı geçmesin' -> ust sinir uygulanir", () => {
    const shoes = conversation(plan("erkek koşu ayakkabısı"));
    const refined = conversation(plan(shoes.query, shoes.steps, "5 bin lirayı geçmesin"));
    expect(refined.reply?.outcome).toBe("applied");
    expect(refined.queryObject.filters.price_max).toBe(500_000);
    expect(constraints(refined)).toContain("En fazla 5.000 TL");
  });

  it("anlasilmayan yanit -> unrecognized, durum ve URL degismez", () => {
    const answered = choose(choose(conversation(plan("kask")), "full_face"), "city");
    const result = conversation(plan("kask", answered.steps, "marka önemli değil"));
    expect(result.reply).toEqual({
      outcome: "unrecognized",
      text: "marka önemli değil",
      ignoredPricePreference: false,
    });
    expect(result.steps).toEqual(answered.steps);
    expect(constraints(result)).toEqual(constraints(answered));
  });

  it("tek bilinmeyen kelime yeni arama sayilmaz, acikca sorulur", () => {
    const result = conversation(plan("kask", [], "parfüm"));
    expect(result.reply?.outcome).toBe("unrecognized");
    expect(result.query).toBe("kask");
  });

  it("'daha ucuzları' uygulanmis gibi yapilmaz: unsupported_preference", () => {
    const shoes = conversation(plan("erkek koşu ayakkabısı"));
    const result = conversation(plan(shoes.query, shoes.steps, "daha ucuzları"));
    expect(result.reply?.outcome).toBe("unsupported_preference");
    expect(result.steps).toEqual(shoes.steps);
    expect(result.queryObject.filters.price_max).toBeUndefined();
  });

  it("uygulanan degisiklige eklenen fiyat tercihi ayrica bildirilir", () => {
    const result = conversation(plan("erkek koşu ayakkabısı", [], "siyah ve ucuz olsun"));
    expect(result.reply?.outcome).toBe("applied");
    expect(result.reply?.ignoredPricePreference).toBe(true);
    expect(result.queryObject.filters.color).toEqual(["black"]);
  });

  it("sonuclar gorunurken 'siyah olanlar' ayni durumu daraltir", () => {
    const shoes = conversation(plan("erkek koşu ayakkabısı"));
    const refined = conversation(plan(shoes.query, shoes.steps, "siyah olanlar"));
    expect(refined.reply?.outcome).toBe("applied");
    expect(refined.queryObject.filters.color).toEqual(["black"]);
  });
});

describe("urun ailesi degisimi", () => {
  it("kask -> kapalı -> 'masa lambası': yeni arama, kask durumu tasinmaz", () => {
    const answered = choose(conversation(plan("kask")), "full_face");
    const result = plan("kask", answered.steps, "masa lambası");
    expect(result).toMatchObject({
      mode: "conventional",
      query: "masa lambası",
      reply: { outcome: "new_search" },
    });
  });

  it("kask -> 'masa lambası bakıyorum': arama fiili ile yeni arama", () => {
    const result = plan("kask", [], "masa lambası bakıyorum");
    expect(result).toMatchObject({ mode: "conventional", query: "masa lambası bakıyorum" });
  });

  it("kask -> kapalı -> 'ayakkabı bakıyorum': yeni konusma, kask fasetleri yok", () => {
    const answered = choose(conversation(plan("kask")), "full_face");
    const shoes = conversation(plan("kask", answered.steps, "ayakkabı bakıyorum"));
    expect(shoes.reply?.outcome).toBe("new_search");
    expect(shoes.query).toBe("ayakkabı bakıyorum");
    expect(shoes.steps).toEqual([]);
    expect(shoes.question?.id).toBe("shoe_type");
    expect(shoes.constraints).toEqual([]);
    expect(shoes.context).toEqual([]);
    expect(shoes.queryObject.unparsed).toBe("ayakkabı");
  });

  it("tercih cumlesi yeni arama sayilmaz: 'yağmurda da kullanacağım'", () => {
    const result = conversation(plan("kask", [], "yağmurda da kullanacağım"));
    expect(result.reply?.outcome).toBe("unrecognized");
    expect(result.query).toBe("kask");
  });
});

describe("planConversation: dayaniklilik", () => {
  it("kisit cipini kaldirma o faseti atlar ve soruyu tekrar sormaz", () => {
    const answered = choose(choose(conversation(plan("kask")), "full_face"), "city");
    const chip = answered.constraints.find((c) => c.key === "facet:helmet_type");
    const removed = conversation(plan("kask", chip?.removeSteps ?? []));
    expect(constraints(removed)).toEqual([]);
    expect(removed.question).toBeNull();
  });

  it("bozuk ya da bayat adimlar hataya dusurmez", () => {
    const result = conversation(plan("kask", ["a~helmet_type~yok_boyle", "a~use_case~city"]));
    expect(result.droppedInvalidStep).toBe(true);
    expect(result.steps).toEqual([]);
    expect(result.question?.id).toBe("helmet_type");
  });

  it("bos sorgu konusma baslatmaz", () => {
    expect(plan("   ")).toMatchObject({ mode: "conventional", reason: "empty" });
  });
});

describe("replyToInput", () => {
  it("acik soru yokken 'fark etmez' metin olarak kalir", () => {
    expect(replyToInput("fark etmez", null)).toEqual({ type: "text", text: "fark etmez" });
  });

  it("'Sonuçları göster!' aramaya gecer", () => {
    expect(replyToInput("Sonuçları göster!", "helmet_type")).toEqual({ type: "show_results" });
  });
});

describe("budgetLabel", () => {
  it("ek gerektirmeyen bicim kullanir", () => {
    expect(budgetLabel(null, 500_000)).toBe("En fazla 5.000 TL");
    expect(budgetLabel(250_000, null)).toBe("En az 2.500 TL");
    expect(budgetLabel(50_000, 100_000)).toBe("500 TL – 1.000 TL");
  });
});
