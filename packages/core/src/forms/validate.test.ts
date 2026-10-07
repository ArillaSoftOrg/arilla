import { describe, expect, it } from "vitest";
import {
  type AnswerableQuestion,
  FORM_LIMITS,
  FormValidationError,
  parseLocalDateTime,
  validateAnswers,
  validateFormDefinition,
} from "./validate.ts";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: "ornek-anket",
    title: "Örnek anket",
    description: "Açıklama",
    audience: "public",
    kind: "survey",
    allowSkip: false,
    allowMultipleResponses: false,
    startsAt: "",
    endsAt: "",
    questions: [
      { label: "Soru 1", type: "single_choice", required: true, options: ["A", "B"] },
      { label: "Soru 2", type: "long_text", required: false, options: [] },
    ],
    ...overrides,
  };
}

function rejects(input: unknown): string {
  try {
    validateFormDefinition(input);
  } catch (error) {
    expect(error).toBeInstanceOf(FormValidationError);
    return (error as Error).message;
  }
  throw new Error("beklenen hata oluşmadı");
}

describe("validateFormDefinition()", () => {
  it("geçerli tanımı kabul eder ve metinleri temizler", () => {
    const def = validateFormDefinition(
      validInput({ title: "  Örnek\u0000 anket  ", description: "" }),
    );
    expect(def.title).toBe("Örnek anket");
    expect(def.description).toBeNull();
    expect(def.questions).toHaveLength(2);
    expect(def.questions[0]?.options).toEqual(["A", "B"]);
  });

  it("slug biçimini zorlar", () => {
    for (const slug of ["", "ab", "Büyük-Harf", "boşluk var", "-baş", "son-", "çift--tire"]) {
      expect(rejects(validInput({ slug }))).toBeTruthy();
    }
    expect(validateFormDefinition(validInput({ slug: "a1-b2-c3" })).slug).toBe("a1-b2-c3");
  });

  it("başlığı zorunlu tutar ve uzunluğu sınırlar", () => {
    expect(rejects(validInput({ title: "   " }))).toMatch(/Başlık/);
    expect(rejects(validInput({ title: "x".repeat(FORM_LIMITS.titleMax + 1) }))).toMatch(/Başlık/);
  });

  it("izin listesi dışı kitle ve türü reddeder", () => {
    expect(rejects(validInput({ audience: "everyone" }))).toMatch(/Hedef kitle/);
    expect(rejects(validInput({ kind: "quiz" }))).toMatch(/tür/);
  });

  it("onboarding formunu herkese açık yapmaz", () => {
    expect(rejects(validInput({ kind: "onboarding", audience: "public" }))).toMatch(/Onboarding/);
    expect(
      validateFormDefinition(validInput({ kind: "onboarding", audience: "early_access" })).kind,
    ).toBe("onboarding");
  });

  it("en az bir soru ister ve üst sınırı uygular", () => {
    expect(rejects(validInput({ questions: [] }))).toMatch(/soru/);
    const many = Array.from({ length: FORM_LIMITS.questionsMax + 1 }, (_, i) => ({
      label: `S${i}`,
      type: "short_text",
    }));
    expect(rejects(validInput({ questions: many }))).toMatch(/En fazla/);
  });

  it("seçimli soruda 2-20 seçenek ister, boş satırları atar, tekrarı reddeder", () => {
    const q = (options: string[]) => ({ label: "S", type: "single_choice", options });
    expect(rejects(validInput({ questions: [q(["A"])] }))).toMatch(/seçenek/);
    expect(rejects(validInput({ questions: [q(["A", "a"])] }))).toMatch(/aynı seçenek/);
    expect(
      rejects(validInput({ questions: [q(Array.from({ length: 21 }, (_, i) => `O${i}`))] })),
    ).toMatch(/seçenek/);
    const def = validateFormDefinition(validInput({ questions: [q(["A", "", "  ", "B"])] }));
    expect(def.questions[0]?.options).toEqual(["A", "B"]);
  });

  it("metin sorusunda seçenek kabul etmez ve soru türünü doğrular", () => {
    expect(
      rejects(validInput({ questions: [{ label: "S", type: "short_text", options: ["A"] }] })),
    ).toMatch(/seçenek olamaz/);
    expect(rejects(validInput({ questions: [{ label: "S", type: "slider" }] }))).toMatch(/türü/);
  });

  it("tarihleri Türkiye saati olarak okur ve sırayı denetler", () => {
    expect(parseLocalDateTime("2026-10-03T12:00", "x")?.toISOString()).toBe(
      "2026-10-03T09:00:00.000Z",
    );
    expect(parseLocalDateTime("", "x")).toBeNull();
    expect(() => parseLocalDateTime("03.10.2026", "x")).toThrow(FormValidationError);
    expect(
      rejects(validInput({ startsAt: "2026-10-05T10:00", endsAt: "2026-10-04T10:00" })),
    ).toMatch(/Bitiş/);
  });

  it("boolean olmayan bayrakları reddeder", () => {
    expect(rejects(validInput({ allowSkip: "true" }))).toMatch(/Geçilebilir/);
  });
});

const QUESTIONS: AnswerableQuestion[] = [
  { id: 1, type: "single_choice", required: true, options: [{ id: 11 }, { id: 12 }] },
  {
    id: 2,
    type: "multiple_choice",
    required: false,
    options: [{ id: 21 }, { id: 22 }, { id: 23 }],
  },
  { id: 3, type: "short_text", required: false, options: [] },
  { id: 4, type: "long_text", required: true, options: [] },
];

function answers(entries: Array<[string, unknown]>) {
  return validateAnswers(QUESTIONS, entries);
}

describe("validateAnswers()", () => {
  it("geçerli cevapları seçenek kimliği ve metin olarak döndürür", () => {
    const result = answers([
      ["q_1", "12"],
      ["q_2", "21"],
      ["q_2", "23"],
      ["q_3", "  kısa   yanıt "],
      ["q_4", "Uzun\r\nyanıt"],
    ]);
    expect(result).toEqual({
      ok: true,
      answers: [
        { questionId: 1, optionId: 12, textValue: null },
        { questionId: 2, optionId: 21, textValue: null },
        { questionId: 2, optionId: 23, textValue: null },
        { questionId: 3, optionId: null, textValue: "kısa yanıt" },
        { questionId: 4, optionId: null, textValue: "Uzun\nyanıt" },
      ],
    });
  });

  it("zorunlu soruyu boş bırakmayı reddeder, isteğe bağlıyı kabul eder", () => {
    const result = answers([["q_3", ""]]);
    expect(result).toEqual({ ok: false, fieldErrors: { 1: "required", 4: "required" } });
  });

  it("başka sorunun ya da uydurma seçenek kimliğini reddeder", () => {
    expect(
      answers([
        ["q_1", "21"],
        ["q_4", "x"],
      ]),
    ).toMatchObject({
      ok: false,
      fieldErrors: { 1: "invalid" },
    });
    expect(
      answers([
        ["q_1", "abc"],
        ["q_4", "x"],
      ]),
    ).toMatchObject({
      ok: false,
      fieldErrors: { 1: "invalid" },
    });
    expect(
      answers([
        ["q_1", "11"],
        ["q_2", "99"],
        ["q_4", "x"],
      ]),
    ).toMatchObject({
      ok: false,
      fieldErrors: { 2: "invalid" },
    });
  });

  it("tek seçimde birden fazla değeri reddeder", () => {
    expect(
      answers([
        ["q_1", "11"],
        ["q_1", "12"],
        ["q_4", "x"],
      ]),
    ).toMatchObject({
      ok: false,
      fieldErrors: { 1: "invalid" },
    });
  });

  it("çoklu seçimde tekrar eden seçeneği tek sayar", () => {
    const result = answers([
      ["q_1", "11"],
      ["q_2", "21"],
      ["q_2", "21"],
      ["q_4", "x"],
    ]);
    expect(result.ok && result.answers.filter((a) => a.questionId === 2)).toHaveLength(1);
  });

  it("metin uzunluğu sınırını uygular", () => {
    expect(
      answers([
        ["q_1", "11"],
        ["q_3", "x".repeat(FORM_LIMITS.shortTextMax + 1)],
        ["q_4", "x"],
      ]),
    ).toMatchObject({ ok: false, fieldErrors: { 3: "too_long" } });
    expect(
      answers([
        ["q_1", "11"],
        ["q_4", "x".repeat(FORM_LIMITS.longTextMax + 1)],
      ]),
    ).toMatchObject({ ok: false, fieldErrors: { 4: "too_long" } });
  });

  it("bilinmeyen alanı (istemcinin user_id'si dahil) formu reddederek geri çevirir", () => {
    for (const key of ["user_id", "userId", "q_99", "q_1x", "response_id"]) {
      expect(
        answers([
          ["q_1", "11"],
          ["q_4", "x"],
          [key, "1"],
        ]),
      ).toEqual({
        ok: false,
        fieldErrors: {},
        formError: "malformed",
      });
    }
  });

  it("Next'in $ACTION alanlarını yok sayar, metin olmayan değeri reddeder", () => {
    expect(
      answers([
        ["$ACTION_ID_abc", "1"],
        ["q_1", "11"],
        ["q_4", "x"],
      ]).ok,
    ).toBe(true);
    expect(
      answers([
        ["q_1", new Blob(["x"])],
        ["q_4", "x"],
      ]),
    ).toMatchObject({
      ok: false,
      formError: "malformed",
    });
  });

  it("aşırı büyük gövdeyi alan sınırlarından önce reddeder", () => {
    expect(answers([["q_4", "x".repeat(FORM_LIMITS.payloadMax + 1)]])).toEqual({
      ok: false,
      fieldErrors: {},
      formError: "too_large",
    });
    const many: Array<[string, string]> = Array.from({ length: FORM_LIMITS.entriesMax + 1 }, () => [
      "q_2",
      "21",
    ]);
    expect(answers(many)).toMatchObject({ ok: false, formError: "too_large" });
  });

  it("NUL ve kontrol karakterlerini atar", () => {
    const result = answers([
      ["q_1", "11"],
      ["q_4", "a\u0000b\u0007c"],
    ]);
    expect(result.ok && result.answers.at(-1)?.textValue).toBe("abc");
  });
});
