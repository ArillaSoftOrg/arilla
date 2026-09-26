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

function labels(current: Conversation): string[] {
  return current.understood.map((chip) => chip.label);
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
    expect(labels(second)).toEqual(["Kapalı (full face)"]);
    expect(second.queryObject.unparsed).toBe("kapalı kask");
    expect(second.action).toBe("clarify");
    expect(second.question?.id).toBe("use_case");

    const third = choose(second, "city");
    expect(third.action).toBe("search");
    expect(third.question).toBeNull();
    expect(labels(third)).toEqual(["Kapalı (full face)", "Şehir içi"]);
  });

  it("B) kask -> kapalı -> 'aslında modüler olsun': tek deger kalir", () => {
    const answered = choose(conversation(plan("kask")), "full_face");
    const corrected = conversation(plan("kask", answered.steps, "aslında modüler olsun"));
    expect(labels(corrected)).toContain("Modüler (çene açılır)");
    expect(labels(corrected)).not.toContain("Kapalı (full face)");
    expect(corrected.queryObject.unparsed).toBe("çene açılır kask");
    // Yanit URL adimlarina yazilir; tekrar oynatma ayni durumu kurar.
    expect(corrected.steps.at(-1)).toBe("t~aslında modüler olsun");
    const replayed = conversation(plan("kask", corrected.steps));
    expect(labels(replayed)).toEqual(labels(corrected));
  });

  it("C) hediye -> alici -> ilgi/butce -> arama", () => {
    const first = conversation(plan("hediye arıyorum"));
    expect(first.question?.id).toBe("recipient");
    const second = conversation(plan(first.query, first.steps, "annem için"));
    expect(labels(second)).toEqual(["Annem"]);
    expect(second.action).toBe("clarify");
    expect(["interest", "budget"]).toContain(second.question?.id);

    const third = choose(second, "beauty");
    const fourth = third.action === "clarify" ? choose(third, "500_1000") : third;
    expect(fourth.action).toBe("search");
    expect(fourth.queryObject.filters.category_path).toBe("saglik-kozmetik");
  });

  it("D) '1000 liraya anneme hediye': bilinen alici ve butce tekrar sorulmaz", () => {
    const first = conversation(plan("1000 liraya anneme hediye"));
    expect(first.question?.id).not.toBe("recipient");
    expect(first.question?.id).not.toBe("budget");
    expect(labels(first)).toContain("Annem");
    if (first.action === "clarify") expect(first.question?.id).toBe("interest");
  });

  it("E) iphone 16 kılıfı: konusma yok, dogrudan arama", () => {
    expect(plan("iphone 16 kılıfı")).toMatchObject({ mode: "conventional", reason: "no_domain" });
  });

  it("F) siyah erkek koşu ayakkabısı: soru sorulmadan aranir", () => {
    const result = conversation(plan("siyah erkek koşu ayakkabısı"));
    expect(result.action).toBe("search");
    expect(labels(result)).toEqual(expect.arrayContaining(["Koşu", "Erkek", "Siyah"]));
  });

  it("G) ayakkabı: netlestirme sorusu", () => {
    const result = conversation(plan("ayakkabı"));
    expect(result.action).toBe("clarify");
    expect(result.question?.id).toBe("shoe_type");
  });

  it("H) masa lambası: dogrudan arama", () => {
    expect(plan("masa lambası").mode).toBe("conventional");
  });

  it("I) 'Emin değilim' / 'fark etmez' soruyu kapatir, arama genis kalir, kullanici hapsolmaz", () => {
    const first = conversation(plan("kask"));
    const skipped = conversation(plan("kask", first.question?.skip.steps ?? []));
    // Motor politikasi: atlanan soru bir daha sorulmaz; sinyal azsa bir
    // "useful" soru daha gelebilir, ama sorgu en genis haliyle aranir.
    expect(skipped.question?.id).not.toBe("helmet_type");
    expect(skipped.queryObject.unparsed).toBe("kask");
    expect(skipped.understood).toEqual([]);

    const typed = conversation(plan("kask", [], "fark etmez"));
    expect(typed.steps).toEqual(["s~helmet_type"]);
    expect(typed.question?.id).not.toBe("helmet_type");

    // "Sonuçları göster" her zaman aramaya gecer.
    const shown = conversation(plan("kask", skipped.question?.showResults.steps ?? []));
    expect(shown.action).toBe("search");
    expect(shown.queryObject.unparsed).toBe("kask");
  });
});

describe("planConversation: sonuclar sonrasi ve dayaniklilik", () => {
  it("sonuclar gorunurken 'siyah olanlar' ayni durumu daraltir", () => {
    const shoes = conversation(plan("erkek koşu ayakkabısı"));
    const refined = conversation(plan(shoes.query, shoes.steps, "siyah olanlar"));
    expect(refined.queryObject.filters.color).toEqual(["black"]);
    expect(labels(refined)).toEqual(expect.arrayContaining(["Koşu", "Erkek", "Siyah"]));
  });

  it("'daha ucuzları' sayi uydurmaz, yalnizca tercih bildirir", () => {
    const refined = conversation(plan("erkek koşu ayakkabısı", [], "daha ucuzları"));
    expect(refined.prefersLowerPrice).toBe(true);
    expect(refined.queryObject.filters.price_max).toBeUndefined();
  });

  it("cip kaldirma o faseti atlar ve soruyu tekrar sormaz", () => {
    const answered = choose(choose(conversation(plan("kask")), "full_face"), "city");
    const chip = answered.understood.find((c) => c.key === "facet:helmet_type");
    const removed = conversation(plan("kask", chip?.removeSteps ?? []));
    expect(labels(removed)).not.toContain("Kapalı (full face)");
    expect(removed.question?.id).not.toBe("helmet_type");
  });

  it("baska urun ailesine gecen yanit yeni konusma baslatir", () => {
    const helmet = conversation(plan("kask"));
    const shoes = conversation(plan("kask", helmet.steps, "ayakkabı bakıyorum"));
    expect(shoes.query).toBe("ayakkabı bakıyorum");
    expect(shoes.steps).toEqual([]);
    expect(shoes.question?.id).toBe("shoe_type");
  });

  it("domain tetiklemeyen takip metni ayni konusmada kalir (yeni arama ust kutudan)", () => {
    // Motor "masa lambası"nı kask konusmasinin takibi sayar; yeni bir arama
    // icin arayuz ust arama kutusunu ayri tutar.
    const result = conversation(plan("kask", [], "masa lambası"));
    expect(result.query).toBe("kask");
    expect(result.queryObject.unparsed).toBe("kask");
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
