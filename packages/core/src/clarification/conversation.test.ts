import { describe, expect, it } from "vitest";
import { compileQuery } from "./compile.ts";
import { replayConversation, step } from "./engine.ts";
import { createInitialState, InvalidClarificationInputError } from "./state.ts";
import { TEST_CATEGORY_PATHS, TEST_CONTEXT } from "./test-fixtures.ts";
import type { ClarificationDecision, ClarificationInput } from "./types.ts";
import { appendInput, decodeInputs, encodeInput } from "./url-state.ts";

function run(inputs: readonly ClarificationInput[]): ClarificationDecision {
  return replayConversation(inputs, TEST_CONTEXT).decision;
}

describe("kask akisi", () => {
  it("tur 1 tipi sorar, tur 2 kullanim amacini sorar, tur 3 arar", () => {
    const t1 = step(createInitialState(), { type: "text", text: "kask arıyorum" }, TEST_CONTEXT);
    expect(t1.action).toBe("clarify");
    expect(t1.action === "clarify" && t1.question.id).toBe("helmet_type");
    expect(t1.state.domainId).toBe("helmet");

    const t2 = step(
      t1.state,
      { type: "answer", questionId: "helmet_type", optionId: "full_face" },
      TEST_CONTEXT,
    );
    expect(t2.state.facets.helmet_type).toMatchObject({
      optionId: "full_face",
      source: "explicit",
    });
    expect(t2.action === "clarify" && t2.question.id).toBe("use_case");

    const t3 = step(
      t2.state,
      { type: "answer", questionId: "use_case", optionId: "city" },
      TEST_CONTEXT,
    );
    // Soru butcesi (maxQuestions: 2) doldu: arama.
    expect(t3.action).toBe("search");

    const query = compileQuery(t3.state, TEST_CONTEXT.registry, {
      knownCategoryPaths: TEST_CATEGORY_PATHS,
    });
    expect(query.unparsed).toBe("kapalı kask");
    expect(query.filters).toEqual({});
  });

  it('"aslında açık olsun": son acik beyan kazanir, celiski kalmaz', () => {
    const decision = run([
      { type: "text", text: "kask arıyorum" },
      { type: "answer", questionId: "helmet_type", optionId: "full_face" },
      { type: "text", text: "aslında açık olsun" },
    ]);
    expect(decision.state.facets.helmet_type?.optionId).toBe("open_face");
    const values = Object.values(decision.state.facets).map((f) => f.optionId);
    expect(values).not.toContain("full_face");
    const query = compileQuery(decision.state, TEST_CONTEXT.registry);
    expect(query.unparsed).toBe("jet kask");
  });

  it("ima edilen deger acik cevabi ezmez; acik cevap ima edileni ezer", () => {
    const decision = run([
      { type: "text", text: "kask" },
      { type: "answer", questionId: "use_case", optionId: "city" },
      { type: "answer", questionId: "helmet_type", optionId: "off_road" },
    ]);
    // off_road use_case=off_road ima eder ama kullanici acikca "city" demisti.
    expect(decision.state.facets.use_case).toMatchObject({ optionId: "city", source: "explicit" });

    const later = run([
      { type: "text", text: "kask" },
      { type: "answer", questionId: "helmet_type", optionId: "off_road" },
    ]);
    expect(later.state.facets.use_case).toMatchObject({ optionId: "off_road", source: "inferred" });
  });
});

describe("hediye akisi", () => {
  it("alici -> ilgi (arada butce serbest metinle) -> arama", () => {
    const t1 = run([{ type: "text", text: "hediye arıyorum" }]);
    expect(t1.action === "clarify" && t1.question.id).toBe("recipient");

    const t2 = run([
      { type: "text", text: "hediye arıyorum" },
      { type: "text", text: "babam için" },
    ]);
    expect(t2.state.facets.recipient?.optionId).toBe("father");
    expect(t2.action === "clarify" && t2.question.id).toBe("interest");

    const t3 = run([
      { type: "text", text: "hediye arıyorum" },
      { type: "text", text: "babam için" },
      { type: "text", text: "500-1000 arası" },
    ]);
    expect(t3.state.budget).toMatchObject({ minKurus: 50000, maxKurus: 100000 });
    expect(t3.action === "clarify" && t3.question.id).toBe("interest");

    const t4 = run([
      { type: "text", text: "hediye arıyorum" },
      { type: "text", text: "babam için" },
      { type: "text", text: "500-1000 arası" },
      { type: "text", text: "teknoloji seviyor" },
    ]);
    expect(t4.action).toBe("search");
    expect(t4.state.facets.interest?.optionId).toBe("technology");
    expect(t4.state.intent).toBe("gift");

    const query = compileQuery(t4.state, TEST_CONTEXT.registry, {
      knownCategoryPaths: TEST_CATEGORY_PATHS,
    });
    expect(query.filters).toEqual({
      category_path: "elektronik",
      price_min: 50000,
      price_max: 100000,
    });
    expect(query.unparsed).toBe("");
  });

  it("cocuk alicida yas sorulur; yetiskin alicida sorulmaz", () => {
    const child = run([
      { type: "text", text: "hediye" },
      { type: "answer", questionId: "recipient", optionId: "child" },
    ]);
    expect(child.action === "clarify" && child.question.id).toBe("age_band");

    const mother = run([
      { type: "text", text: "hediye" },
      { type: "answer", questionId: "recipient", optionId: "mother" },
    ]);
    expect(mother.action === "clarify" && mother.question.id).toBe("interest");
  });

  it("alici degisirse artik uygulanmayan yas bandi aramaya girmez", () => {
    const decision = run([
      { type: "text", text: "2 yaşındaki bebeğe hediye" },
      { type: "answer", questionId: "recipient", optionId: "mother" },
      { type: "show_results" },
    ]);
    const query = compileQuery(decision.state, TEST_CONTEXT.registry, {
      knownCategoryPaths: TEST_CATEGORY_PATHS,
    });
    expect(query.filters.category_path).toBeUndefined();
  });
});

describe("atlama", () => {
  it('"Emin değilim" soruyu kapatir, tekrar sorulmaz, en genis arama yapilir', () => {
    const decision = run([
      { type: "text", text: "kask" },
      { type: "skip", questionId: "helmet_type" },
      { type: "skip", questionId: "use_case" },
    ]);
    expect(decision.action).toBe("search");
    expect(decision.state.skippedFacets).toEqual(["helmet_type", "use_case"]);
    const query = compileQuery(decision.state, TEST_CONTEXT.registry);
    expect(query.unparsed).toBe("kask");
    expect(query.filters).toEqual({});
  });

  it('"Fark etmez" onceden secilmis degeri kaldirir', () => {
    const decision = run([
      { type: "text", text: "full face kask" },
      { type: "skip", questionId: "helmet_type" },
    ]);
    expect(decision.state.facets.helmet_type).toBeUndefined();
  });

  it('"sonuçları göster" her zaman aramaya gecer', () => {
    const decision = run([{ type: "text", text: "hediye" }, { type: "show_results" }]);
    expect(decision.action).toBe("search");
    expect(decision.state.clarificationStatus).toBe("user_requested_results");
  });

  it("cevapsiz kalan soru en fazla iki kez sorulur, kullanici hapsolmaz", () => {
    const decision = run([
      { type: "text", text: "kask" },
      { type: "text", text: "bilmiyorum" },
      { type: "text", text: "hmm" },
    ]);
    expect(decision.action).toBe("search");
    expect(decision.state.askCounts.helmet_type).toBe(2);
  });
});

describe("gecersiz girdi", () => {
  it("tanimsiz secenek reddedilir", () => {
    const t1 = step(createInitialState(), { type: "text", text: "kask" }, TEST_CONTEXT);
    expect(() =>
      step(
        t1.state,
        { type: "answer", questionId: "helmet_type", optionId: "carbon" },
        TEST_CONTEXT,
      ),
    ).toThrow(InvalidClarificationInputError);
  });

  it("domain'e ait olmayan faset reddedilir", () => {
    const t1 = step(createInitialState(), { type: "text", text: "kask" }, TEST_CONTEXT);
    expect(() =>
      step(t1.state, { type: "answer", questionId: "recipient", optionId: "mother" }, TEST_CONTEXT),
    ).toThrow(InvalidClarificationInputError);
  });

  it("tekrar oynatma gecersiz adimda durur, hata firlatmaz", () => {
    const { decision, rejectedInput } = replayConversation(
      [
        { type: "text", text: "kask" },
        { type: "answer", questionId: "helmet_type", optionId: "carbon" },
      ],
      TEST_CONTEXT,
    );
    expect(rejectedInput).toMatchObject({ optionId: "carbon" });
    expect(decision.action === "clarify" && decision.question.id).toBe("helmet_type");
  });
});

describe("determinizm ve URL", () => {
  const inputs: ClarificationInput[] = [
    { type: "text", text: "hediye arıyorum" },
    { type: "answer", questionId: "recipient", optionId: "father" },
    { type: "text", text: "500-1000 arası" },
    { type: "answer", questionId: "interest", optionId: "technology" },
  ];

  it("ayni girdi dizisi ayni durumu uretir", () => {
    expect(run(inputs)).toEqual(run(inputs));
  });

  it("adim adim ilerleme ile tekrar oynatma ayni sonucu verir", () => {
    let decision = step(createInitialState(), inputs[0] as ClarificationInput, TEST_CONTEXT);
    for (const input of inputs.slice(1)) decision = step(decision.state, input, TEST_CONTEXT);
    expect(decision).toEqual(run(inputs));
  });

  it("URL kodlamasi tur atlatir", () => {
    const encoded = inputs.slice(1).map(encodeInput);
    expect(encoded).toEqual(["a~recipient~father", "t~500-1000 arası", "a~interest~technology"]);
    expect(decodeInputs(encoded)).toEqual(inputs.slice(1));
  });

  it("bozuk URL parcalari atlanir", () => {
    expect(decodeInputs(["a~Recipient~father", "x~y", "s~", "a~a~b~c", "r"])).toEqual([
      { type: "show_results" },
    ]);
  });

  it("adim siniri asilinca son adim sonuclari gostermeye doner", () => {
    const many = Array.from({ length: 8 }, () => ({ type: "skip", questionId: "budget" }) as const);
    const params = appendInput(many, { type: "skip", questionId: "use_case" });
    expect(params).toHaveLength(8);
    expect(params.at(-1)).toBe("r");
  });
});

describe("domain degisimi", () => {
  it("baska bir urun ailesine gecis yeni konusma baslatir", () => {
    const decision = run([
      { type: "text", text: "kask" },
      { type: "answer", questionId: "helmet_type", optionId: "full_face" },
      { type: "text", text: "aslında ayakkabı bakıyorum" },
    ]);
    expect(decision.state.domainId).toBe("shoes");
    expect(decision.state.facets.helmet_type).toBeUndefined();
    expect(decision.action === "clarify" && decision.question.id).toBe("shoe_type");
  });
});
