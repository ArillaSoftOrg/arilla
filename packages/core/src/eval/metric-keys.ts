/**
 * Kaydedilen degerlendirme metriklerinin anahtar sozlesmesi (karar 0096/0097).
 *
 * `ai_eval_run.metrics` duz bir `{anahtar: sayi}` nesnesidir. Panel yalnizca
 * burada tanimli anahtarlari gosterir; anahtar yoksa "Henuz veri yok" yazar,
 * asla 0 uydurmaz. Yazici (`recordEvalRun`) ve panel ayni sozlesmeyi kullanir.
 */
import type { EvalComponent } from "@arilla/db";
import type { Direction } from "./metrics.ts";

export interface MetricSpec {
  key: string;
  label: string;
  /** Iyi yon; regresyon bu yone gore hesaplanir. */
  direction: Direction;
  /** `ratio`: 0..1 oran, yuzde gosterilir. */
  kind: "ratio";
}

const ratio = (key: string, label: string, direction: Direction): MetricSpec => ({
  key,
  label,
  direction,
  kind: "ratio",
});

export const COMPONENT_LABELS: Record<EvalComponent, string> = {
  gemini_intent: "Gemini niyet analizi",
  matching: "Ürün eşleştirme",
  jina_image: "Görsel benzerlik",
  search: "Arama",
};

export const COMPONENT_ORDER: readonly EvalComponent[] = [
  "gemini_intent",
  "matching",
  "jina_image",
  "search",
];

export const COMPONENT_METRICS: Record<EvalComponent, readonly MetricSpec[]> = {
  gemini_intent: [
    ratio("accuracy", "Doğruluk", "higher"),
    ratio("macro_f1", "Macro-F1", "higher"),
    ratio("exact_pass_rate", "Tam geçen vaka", "higher"),
  ],
  matching: [
    ratio("queue_precision", "Precision (kuyruk)", "higher"),
    ratio("queue_recall", "Recall (kuyruk)", "higher"),
    ratio("queue_f1", "F1 (kuyruk)", "higher"),
    ratio("auto_precision", "Precision (otomatik kabul)", "higher"),
    ratio("auto_recall", "Recall (otomatik kabul)", "higher"),
    ratio("auto_f1", "F1 (otomatik kabul)", "higher"),
    ratio("queue_false_match_rate", "Yanlış eşleştirme oranı (kuyruk)", "lower"),
    ratio("auto_false_match_rate", "Yanlış eşleştirme oranı (otomatik)", "lower"),
  ],
  jina_image: [
    ratio("precision_at_5", "Precision@5", "higher"),
    ratio("ndcg_at_10", "NDCG@10", "higher"),
    ratio("auc", "AUC", "higher"),
    ratio("false_match_rate", "Yanlış eşleştirme oranı", "lower"),
  ],
  search: [
    ratio("precision_at_5", "Precision@5", "higher"),
    ratio("ndcg_at_10", "NDCG@10", "higher"),
    ratio("zero_result_rate", "Sıfır sonuç oranı", "lower"),
    ratio("miss_rate", "Kaçırma oranı (ilgili sonuç yok)", "lower"),
    ratio("absent_correct_rate", "Katalogda yok: doğru boş dönme", "higher"),
  ],
};

/** `runIntentEval().summary` → saklanacak metrikler. */
export function intentStoredMetrics(summary: {
  exactPassRate: number;
  action: { accuracy: number; macroF1: number };
}): Record<string, number> {
  return {
    accuracy: summary.action.accuracy,
    macro_f1: summary.action.macroF1,
    exact_pass_rate: summary.exactPassRate,
  };
}

/**
 * `summarizeSearch()` -> saklanacak metrikler. Payda 0 ise metrik YAZILMAZ
 * (panel "veri yok" gosterir); bos kume icin 0 uydurulmaz.
 */
export function searchStoredMetrics(summary: {
  /** Verilmezse paydalar dolu sayilir (eski cagrilar). */
  queries?: number;
  scoredQueries?: number;
  precisionAt5: number;
  ndcgAt10: number;
  zeroResultRate: number;
  missRate: number;
  absentCorrectRate: number;
}): Record<string, number> {
  const queries = summary.queries ?? 1;
  const scored = summary.scoredQueries ?? queries;
  const absent = queries - scored;
  return {
    ...(scored > 0
      ? {
          precision_at_5: summary.precisionAt5,
          ndcg_at_10: summary.ndcgAt10,
          miss_rate: summary.missRate,
        }
      : {}),
    ...(queries > 0 ? { zero_result_rate: summary.zeroResultRate } : {}),
    ...(absent > 0 || summary.queries === undefined
      ? { absent_correct_rate: summary.absentCorrectRate }
      : {}),
  };
}
