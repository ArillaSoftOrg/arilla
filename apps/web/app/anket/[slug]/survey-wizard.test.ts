import { describe, expect, it } from "vitest";
import {
  type Answers,
  clampStep,
  fieldName,
  firstErrorStep,
  isAnswered,
  isLastStep,
  missingRequired,
  progressPercent,
  sameValues,
  shouldAutoAdvance,
  toggleValue,
  type WizardQuestion,
} from "./survey-wizard.ts";

const single: WizardQuestion = { id: 1, type: "single_choice", required: true };
const multi: WizardQuestion = { id: 2, type: "multiple_choice", required: true };
const short: WizardQuestion = { id: 3, type: "short_text", required: false };
const long: WizardQuestion = { id: 4, type: "long_text", required: true };
const questions = [single, multi, short, long];

describe("cevap durumu", () => {
  it("alan adı formdakiyle aynı", () => {
    expect(fieldName(7)).toBe("q_7");
  });

  it("seçimli soru: en az bir seçim; metin: boşluk dışında karakter", () => {
    expect(isAnswered(single, {})).toBe(false);
    expect(isAnswered(single, { q_1: ["10"] })).toBe(true);
    expect(isAnswered(multi, { q_2: [] })).toBe(false);
    expect(isAnswered(long, { q_4: ["   \n "] })).toBe(false);
    expect(isAnswered(long, { q_4: [" merhaba "] })).toBe(true);
  });

  it("zorunlu cevap eksikse ilerlenmez; isteğe bağlı boş olabilir", () => {
    expect(missingRequired(single, {})).toBe(true);
    expect(missingRequired(single, { q_1: ["10"] })).toBe(false);
    expect(missingRequired(short, {})).toBe(false);
    expect(missingRequired(long, { q_4: [""] })).toBe(true);
  });
});

describe("otomatik ilerleme kararı", () => {
  const base = { index: 0, total: 4 };

  it("tek seçimli + bilinçli seçim + son adım değil → ilerler", () => {
    expect(shouldAutoAdvance({ type: "single_choice", deliberate: true, ...base })).toBe(true);
  });

  it("ok tuşuyla seçim ilerletmez (klavye gezintisi)", () => {
    expect(shouldAutoAdvance({ type: "single_choice", deliberate: false, ...base })).toBe(false);
  });

  it("son adımda ilerletmez (gönderim açık eylemdir)", () => {
    expect(shouldAutoAdvance({ type: "single_choice", deliberate: true, index: 3, total: 4 })).toBe(
      false,
    );
  });

  it("çoktan seçmeli ve metin soruları asla otomatik ilerlemez", () => {
    for (const type of ["multiple_choice", "short_text", "long_text"] as const) {
      expect(shouldAutoAdvance({ type, deliberate: true, ...base })).toBe(false);
    }
  });
});

describe("adım sınırları ve ilerleme", () => {
  it("son adım ve sınırlama", () => {
    expect(isLastStep(3, 4)).toBe(true);
    expect(isLastStep(2, 4)).toBe(false);
    expect(isLastStep(0, 1)).toBe(true);
    expect(clampStep(-3, 4)).toBe(0);
    expect(clampStep(9, 4)).toBe(3);
    expect(clampStep(2.9, 4)).toBe(2);
    expect(clampStep(5, 0)).toBe(0);
  });

  it("ilerleme yüzdesi: 1/4, 2/4, 4/4", () => {
    expect([0, 1, 3].map((i) => progressPercent(i, 4))).toEqual([25, 50, 100]);
    expect(progressPercent(0, 0)).toBe(0);
  });
});

describe("geri dönüş ve cevap değiştirme", () => {
  it("cevap geri dönüşte korunur; farklı seçim öncekini değiştirir", () => {
    let answers: Answers = { q_1: ["10"] };
    // 2. adıma geçildi, geri dönüldü: aynı nesne, cevap yerinde.
    expect(answers.q_1).toEqual(["10"]);
    // Farklı cevap seçildi.
    answers = { ...answers, q_1: ["11"] };
    expect(answers.q_1).toEqual(["11"]);
    expect(isAnswered(single, answers)).toBe(true);
  });

  it("çoktan seçmeli işaret ekle/çıkar, sırayı korur", () => {
    let values: string[] = [];
    values = toggleValue(values, "a", true);
    values = toggleValue(values, "b", true);
    values = toggleValue(values, "a", false);
    expect(values).toEqual(["b"]);
    expect(toggleValue(["b"], "b", true)).toEqual(["b"]);
  });
});

describe("sunucu doğrulama hatası", () => {
  it("hata soru SIRASINA göre ilk hatalı adıma götürür", () => {
    expect(firstErrorStep(questions, { 4: "required", 2: "invalid" })).toBe(1);
    expect(firstErrorStep(questions, { 4: "required" })).toBe(3);
    expect(firstErrorStep(questions, {})).toBeNull();
    expect(firstErrorStep(questions, { 99: "required" })).toBeNull();
  });

  it("cevap düzeltildiyse bayat hata gösterilmez", () => {
    expect(sameValues(["a"], ["a"])).toBe(true);
    expect(sameValues(["a"], ["b"])).toBe(false);
    expect(sameValues(undefined, [])).toBe(true);
    expect(sameValues(["a", "b"], ["a"])).toBe(false);
  });
});
