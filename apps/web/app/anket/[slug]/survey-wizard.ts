/**
 * Anket sihirbazının saf mantığı (adım geçişi, ön doğrulama, otomatik ilerleme
 * kararı, hata adımı). React'ten bağımsız: tarayıcısız birim testlenir
 * (`survey-wizard.test.ts`). Sunucu doğrulaması (`submitForm`) değişmedi ve
 * asıl kapıdır; buradaki doğrulama yalnızca kullanıcıyı erken uyarır.
 */

export type SurveyQuestionType = "single_choice" | "multiple_choice" | "short_text" | "long_text";

export interface WizardQuestion {
  id: number;
  type: SurveyQuestionType;
  required: boolean;
}

/** Soru alan adı → değerler. `q_<soru kimliği>` anahtarı formdakiyle aynıdır. */
export type Answers = Record<string, string[]>;

export function fieldName(questionId: number): string {
  return `q_${questionId}`;
}

export function isChoice(type: SurveyQuestionType): boolean {
  return type === "single_choice" || type === "multiple_choice";
}

/** Metin sorusunda yalnızca boşluktan ibaret yanıt boş sayılır. */
export function isAnswered(question: WizardQuestion, answers: Answers): boolean {
  const given = answers[fieldName(question.id)] ?? [];
  if (isChoice(question.type)) return given.length > 0;
  return (given[0] ?? "").trim().length > 0;
}

/** Bu adımdan ilerlemek için eksik zorunlu cevap var mı. */
export function missingRequired(question: WizardQuestion, answers: Answers): boolean {
  return question.required && !isAnswered(question, answers);
}

export function isLastStep(index: number, total: number): boolean {
  return index >= total - 1;
}

export function clampStep(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), total - 1);
}

/**
 * Tek seçimli soruda tıklama/boşluk tuşu cevabı kaydedip sonraki soruya geçer.
 * Geçmez: son adımda (gönderim açık eylemdir), çoktan seçmeli/metin sorusunda,
 * ve ok tuşlarıyla seçimde (radyo grubunda ok tuşu seçer; klavye kullanıcısı
 * seçenekler arasında gezerken sayfa kaçmasın).
 */
export function shouldAutoAdvance(input: {
  type: SurveyQuestionType;
  index: number;
  total: number;
  /** Seçim tıklama/dokunma ya da Boşluk ile mi yapıldı (ok tuşu değil). */
  deliberate: boolean;
}): boolean {
  return (
    input.type === "single_choice" && input.deliberate && !isLastStep(input.index, input.total)
  );
}

/** Sunucunun döndürdüğü alan hatalarından, SORU SIRASINA göre ilk hatalı adım. */
export function firstErrorStep(
  questions: readonly WizardQuestion[],
  fieldErrors: Record<number, string | undefined>,
): number | null {
  const index = questions.findIndex((question) => Boolean(fieldErrors[question.id]));
  return index === -1 ? null : index;
}

/**
 * Sunucu hatası yalnızca gönderilen cevap değişmediyse gösterilir: kullanıcı
 * cevabı düzelttiyse eski hata bayat kalmaz.
 */
export function sameValues(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

/** Çoktan seçmeli işaret değişimi (seçenek kimliği, sırayı koruyarak ekle/çıkar). */
export function toggleValue(current: readonly string[], value: string, checked: boolean): string[] {
  const without = current.filter((item) => item !== value);
  return checked ? [...without, value] : without;
}

/** İlerleme çubuğu yüzdesi: 1. soru = 1/N. */
export function progressPercent(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(((clampStep(index, total) + 1) / total) * 100);
}
