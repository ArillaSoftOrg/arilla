/**
 * `/ara` yapay zekâ arama özeti (docs/decisions/0063). İKİNCİ bir model
 * çağrısı YOK: özet, aynı istekteki doğrulanmış yorumdan (ürün türü, bütçe,
 * uygulanan nitelikler) ve gerçek arama sonucunun yalnızca SAYISINDAN
 * deterministik olarak kurulur. Ürün adı, fiyat, mağaza ya da stok bilgisi
 * girdi olarak bile alınmaz; özet bunları uyduramaz.
 *
 * Katalogda karşılığı olmayan niyetler ("hafif", "16 gb ram", "15 inç")
 * süzgeç gibi gösterilmez; özet bunları dürüstçe "uygulanamadı" diye söyler.
 */
import { budgetLabel } from "../conversational-search/plan.ts";
import { foldForMatch } from "./text-match.ts";

/** Özeti kuran, plan katmanında doğrulanmış yorum. */
export interface SearchSummaryIntent {
  /** Seçilen ürün türünün etiketi ("Laptop / dizüstü bilgisayar"); yoksa null. */
  typeLabel: string | null;
  budget: { minKurus: number | null; maxKurus: number | null } | null;
  /** Aramayı gerçekten değiştiren nitelik etiketleri (çipler). */
  constraintLabels: readonly string[];
  /** Katalogda karşılığı olmadığı için uygulanamayan niyetler. */
  unsupported: readonly string[];
}

interface UnsupportedRule {
  label: string;
  pattern: RegExp;
}

/**
 * Katalog şemasında alanı olmayan, metinden de güvenle okunamayan niyetler
 * (ürün tablosunda ağırlık, RAM, depolama, ekran, pil alanı yok; bkz. 0063).
 * Katlanmış (ASCII) metinde aranır.
 */
const UNSUPPORTED_RULES: readonly UnsupportedRule[] = [
  { label: "hafiflik", pattern: /\b(hafif\w*|agirlik\w*|tasinabilir\w*)\b/ },
  {
    label: "RAM ve depolama",
    pattern: /\b(\d+\s?(gb|tb)|ram|ssd|hdd|depolama\w*|hafiza\w*)\b/,
  },
  { label: "ekran boyutu", pattern: /\b(\d+([.,]\d)?\s?(inc|inch)|ekran\w*)\b/ },
  { label: "pil ömrü", pattern: /\b(pil\w*|batarya\w*|sarj suresi)\b/ },
];

export function detectUnsupportedIntents(query: string): string[] {
  const folded = foldForMatch(query);
  return UNSUPPORTED_RULES.filter((rule) => rule.pattern.test(folded)).map((rule) => rule.label);
}

function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ve ${items[items.length - 1]}`;
}

/**
 * En fazla iki cümle. Yorumdan hiçbir şey çıkmadıysa `null` (özet gösterilmez).
 * `resultCount` gerçek aramanın sonucudur; `usedFallback` tam eşleşme yokken
 * gösterilen yakın sonuçlar içindir.
 */
export function buildSearchSummary(
  intent: SearchSummaryIntent,
  results: { resultCount: number; usedFallback: boolean },
): string | null {
  const parts: string[] = [];
  if (intent.typeLabel) parts.push(intent.typeLabel);
  const budget = intent.budget ? budgetLabel(intent.budget.minKurus, intent.budget.maxKurus) : null;
  if (budget) parts.push(budget);
  for (const label of intent.constraintLabels) {
    if (label !== budget && !parts.includes(label)) parts.push(label);
  }
  if (parts.length === 0) return null;

  const first = `Aramanı “${parts.join(" · ")}” olarak yorumladım.`;
  const found =
    results.resultCount > 0 && !results.usedFallback
      ? `${results.resultCount.toLocaleString("tr-TR")} ürün buldum`
      : "tam eşleşen ürün bulamadım, en yakın sonuçları gösteriyorum";
  const unsupported =
    intent.unsupported.length > 0
      ? `; ${listJoin(intent.unsupported)} bilgisi katalogda olmadığı için buna göre süzemedim`
      : "";
  const second = `${found.charAt(0).toLocaleUpperCase("tr-TR")}${found.slice(1)}${unsupported}.`;
  return `${first} ${second}`;
}
