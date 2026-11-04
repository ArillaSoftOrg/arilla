/**
 * IntentV2 niyet katmani degerlendirmesi (karar 0171 §10). Ag, DB ve model yok.
 *
 * Niyet hatasi ile arama hatasini AYRI olcer: bu modul yalnizca niyeti puanlar.
 * Iki tahmin kaynagi ayni puanlayicidan gecer:
 * - `predictFromLocal`: bugunku deterministik yol (temel, kosul a). Ayristirilamayan
 *   her kelime metin kapisinda zorunlu tokendir; bu yuzden zorunlu ozellik sayilir.
 * - `predictFromValidated`: model ciktisi `validateIntentV2`'den gectikten sonra
 *   (Faz 1B; ham cikti dosyasi disaridan verilir, bu modul cagri yapmaz).
 *
 * Tek bir basari orani URETMEZ: alan dogrulugu, yanlis sert filtre ve niyet
 * korunmasi ayri raporlanir.
 */

import { evidenceTokens, numberSet, sharesToken } from "../intent/evidence.ts";
import type { ValidatedIntentV2 } from "../intent/validate.ts";
import { wordsOf } from "../search/fallback/analyze.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { foldForMatch } from "../search/text-match.ts";

export type GoldStrength = "required" | "preferred" | "excluded";

export interface IntentV2Gold {
  type: string | null;
  type_id: string | null;
  category: string | null;
  role: "main" | "accessory" | "part" | null;
  brand: string | null;
  compat: string | null;
  budget: [number | null, number | null] | null;
  attrs: [string, string, GoldStrength][];
  exclude_brands: string[];
  clarify: boolean;
}

export interface IntentV2Case {
  id: string;
  cat: string;
  lang: "tr" | "en" | "mixed";
  typo: boolean;
  q: string;
  gold: IntentV2Gold;
}

export interface IntentV2Dataset {
  label_source: string;
  lexicon_brands?: string[];
  cases: IntentV2Case[];
}

export type HardField = "budget" | "brand" | "excluded_brand" | "category" | "color" | "size";

export interface IntentPrediction {
  type: string | null;
  role: IntentV2Gold["role"];
  brand: string | null;
  compat: string | null;
  budget: [number | null, number | null] | null;
  /** Olumlu (required/preferred) ve olumsuz (excluded) degerler. */
  positive: string[];
  negative: string[];
  excludeBrands: string[];
  clarify: boolean;
  /** Sert filtreye (sonuc dislayan) donusen degerler. */
  hard: { field: HardField; value: string }[];
}

// ---------------------------------------------------------------------------
// Tahmin uretimi
// ---------------------------------------------------------------------------

/**
 * Bugunku deterministik yol: lexicon filtreleri sert filtredir, ayristirilamayan
 * kelimeler metin kapisinda zorunlu tokendir (bas isim sonda).
 */
export function predictFromLocal(
  query: string,
  lexicon: readonly LexiconEntry[],
): IntentPrediction {
  const parsed = parseQueryText(query, lexicon);
  const words = wordsOf(parsed.unparsed).filter((w) => w.length >= 2 || /\d/u.test(w));
  const head = words.at(-1) ?? null;
  const f = parsed.filters;
  const hard: IntentPrediction["hard"] = [];
  const budget: IntentPrediction["budget"] =
    f.price_min !== undefined || f.price_max !== undefined
      ? [
          f.price_min == null ? null : f.price_min / 100,
          f.price_max == null ? null : f.price_max / 100,
        ]
      : null;
  if (budget) hard.push({ field: "budget", value: `${budget[0]}-${budget[1]}` });
  for (const b of f.brand_include ?? []) hard.push({ field: "brand", value: b });
  for (const b of f.brand_exclude ?? []) hard.push({ field: "excluded_brand", value: b });
  if (f.category_path) hard.push({ field: "category", value: f.category_path });
  for (const c of f.color ?? []) hard.push({ field: "color", value: c });
  if (f.size_norm) hard.push({ field: "size", value: f.size_norm });
  return {
    type: head,
    role: null,
    brand: f.brand_include?.[0] ?? null,
    compat: null,
    budget,
    positive: words.slice(0, -1),
    negative: [],
    excludeBrands: f.brand_exclude ?? [],
    clarify: false,
    hard,
  };
}

/** Dogrulanmis model yorumu: X atilir; H kipindekiler sert filtredir. */
export function predictFromValidated(intent: ValidatedIntentV2): IntentPrediction {
  const kept = intent.criteria.filter((c) => c.mode !== "X");
  const first = (field: string) => kept.find((c) => c.field === field) ?? null;
  const hard: IntentPrediction["hard"] = [];
  const budget: IntentPrediction["budget"] = intent.budget
    ? [
        intent.budget.minKurus === null ? null : intent.budget.minKurus / 100,
        intent.budget.maxKurus === null ? null : intent.budget.maxKurus / 100,
      ]
    : null;
  for (const c of kept.filter((c) => c.mode === "H")) {
    // Yerel yolla ayni bicim: "min-max" (null dahil).
    if (c.field === "budget" && budget) {
      hard.push({ field: "budget", value: `${budget[0]}-${budget[1]}` });
    }
    if (c.field === "brand") hard.push({ field: "brand", value: c.canonical ?? c.value });
    if (c.field === "excluded_brand") {
      hard.push({ field: "excluded_brand", value: c.canonical ?? c.value });
    }
    if (c.field === "category") hard.push({ field: "category", value: c.canonical ?? c.value });
  }
  const brand = first("brand");
  const attrs = kept.filter((c) => c.field === "attribute" && c.strength !== "derived_preferred");
  return {
    type: first("product_type")?.value ?? null,
    role: intent.role,
    // Gosterim (D) kipindeki marka kullanicinin beyani sayilmaz.
    brand: brand && brand.mode !== "D" ? (brand.canonical ?? foldForMatch(brand.value)) : null,
    compat: first("compatible_with")?.value ?? null,
    budget,
    positive: attrs.filter((c) => c.strength !== "excluded").map((c) => c.value),
    negative: attrs.filter((c) => c.strength === "excluded").map((c) => c.value),
    excludeBrands: kept
      .filter((c) => c.field === "excluded_brand" && c.mode !== "D")
      .map((c) => c.canonical ?? foldForMatch(c.value)),
    clarify: intent.clarification?.blocking ?? false,
    hard,
  };
}

// ---------------------------------------------------------------------------
// Puanlama
// ---------------------------------------------------------------------------

function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return sharesToken(a, b) || sharesToken(b, a);
}

/** Uyumluluk: ayni sayilar + en az bir ortak kelime. "iphone 15" != "iphone 15 pro max" degil, sayilar ayni; ek kelimeler zorunlu. */
function sameCompat(gold: string | null, pred: string | null): boolean {
  if (gold === null || pred === null) return gold === pred;
  const g = numberSet(gold);
  const p = numberSet(pred);
  if (g.size !== p.size || [...g].some((n) => !p.has(n))) return false;
  const goldTokens = evidenceTokens(gold);
  const predTokens = new Set(evidenceTokens(pred));
  // Model varyanti ("pro", "max", "oled") kaybolmamali.
  return goldTokens.every((t) => predTokens.has(t) || t.length < 2);
}

function valueMatches(goldValue: string, predValues: readonly string[]): boolean {
  return predValues.some((p) => sharesToken(goldValue, p) || sharesToken(p, goldValue));
}

export interface IntentV2Row {
  id: string;
  cat: string;
  lang: string;
  typo: boolean;
  q: string;
  type: boolean;
  role: boolean;
  compat: boolean;
  brand: boolean;
  budget: boolean;
  attrTp: number;
  attrFp: number;
  attrFn: number;
  falseHard: string[];
  unjudgedHard: string[];
  preserved: boolean;
  reversed: string[];
  missing: string[];
  clarify: boolean;
}

export function scoreCase(testCase: IntentV2Case, pred: IntentPrediction): IntentV2Row {
  const g = testCase.gold;
  const goldPositive = g.attrs.filter(([, , s]) => s !== "excluded").map(([, v]) => v);
  const goldNegative = g.attrs.filter(([, , s]) => s === "excluded").map(([, v]) => v);

  let attrTp = 0;
  let attrFn = 0;
  for (const v of goldPositive) valueMatches(v, pred.positive) ? attrTp++ : attrFn++;
  for (const v of goldNegative) valueMatches(v, pred.negative) ? attrTp++ : attrFn++;
  const attrFp =
    pred.positive.filter(
      (p) =>
        !valueMatches(p, goldPositive) &&
        !sameText(p, g.type) &&
        !(g.compat && sharesToken(g.compat, p)),
    ).length + pred.negative.filter((p) => !valueMatches(p, goldNegative)).length;

  // Yanlis sert filtre: sonuc dislayan ve kullanicinin istegiyle celisen.
  const falseHard: string[] = [];
  const unjudgedHard: string[] = [];
  for (const h of pred.hard) {
    const label = `${h.field}:${h.value}`;
    if (h.field === "budget") {
      const want = g.budget ? `${g.budget[0]}-${g.budget[1]}` : null;
      if (h.value !== want) falseHard.push(label);
    } else if (h.field === "brand") {
      if (g.brand === null || foldForMatch(g.brand) !== foldForMatch(h.value))
        falseHard.push(label);
    } else if (h.field === "excluded_brand") {
      if (!g.exclude_brands.some((b) => foldForMatch(b) === foldForMatch(h.value))) {
        falseHard.push(label);
      }
    } else if (h.field === "category") {
      if (g.category !== null) {
        if (!(h.value === g.category || h.value.startsWith(`${g.category}/`)))
          falseHard.push(label);
      } else if (g.role === "accessory" || g.role === "part") {
        // Aksesuar/parca sorgusunda kategori filtresi aranan urunu dislayabilir;
        // dogru kategori etiketi olmadan yargilanamaz.
        unjudgedHard.push(label);
      } else {
        unjudgedHard.push(label);
      }
    } else {
      unjudgedHard.push(label);
    }
  }

  // Niyet korunmasi: acik kriter kayboldu mu ya da TERSINE mi dondu?
  const missing: string[] = [];
  const reversed: string[] = [];
  if (g.budget) {
    const ok =
      pred.budget !== null && pred.budget[0] === g.budget[0] && pred.budget[1] === g.budget[1];
    if (!ok) missing.push("budget");
  }
  if (g.brand && !(pred.brand && foldForMatch(pred.brand) === foldForMatch(g.brand))) {
    missing.push("brand");
  }
  if (g.compat && !sameCompat(g.compat, pred.compat)) missing.push("compat");
  for (const b of g.exclude_brands) {
    if (!pred.excludeBrands.some((x) => foldForMatch(x) === foldForMatch(b)))
      missing.push(`exclude:${b}`);
    if (pred.brand && foldForMatch(pred.brand) === foldForMatch(b)) reversed.push(`brand:${b}`);
    if (pred.hard.some((h) => h.field === "brand" && foldForMatch(h.value) === foldForMatch(b))) {
      reversed.push(`brand_filter:${b}`);
    }
  }
  for (const v of goldNegative) {
    if (valueMatches(v, pred.positive)) reversed.push(`attr:${v}`);
    else if (!valueMatches(v, pred.negative)) missing.push(`not:${v}`);
  }
  for (const v of goldPositive) if (valueMatches(v, pred.negative)) reversed.push(`attr:${v}`);
  // Uyumlu cihazin markasi urun markasi yapildiysa: istenen urun degisti.
  if (
    g.compat &&
    g.brand === null &&
    pred.hard.some((h) => h.field === "brand" && sharesToken(g.compat as string, h.value))
  ) {
    reversed.push("compat_brand_as_product_brand");
  }

  return {
    id: testCase.id,
    cat: testCase.cat,
    lang: testCase.lang,
    typo: testCase.typo,
    q: testCase.q,
    type: sameText(g.type, pred.type),
    role: g.role === null || pred.role === g.role,
    compat: sameCompat(g.compat, pred.compat),
    brand:
      (g.brand === null && pred.brand === null) ||
      (g.brand !== null &&
        pred.brand !== null &&
        foldForMatch(g.brand) === foldForMatch(pred.brand)),
    budget: JSON.stringify(g.budget) === JSON.stringify(pred.budget),
    attrTp,
    attrFp,
    attrFn,
    falseHard,
    unjudgedHard,
    preserved: missing.length === 0 && reversed.length === 0,
    reversed,
    missing,
    clarify: g.clarify === pred.clarify,
  };
}

export interface IntentV2Summary {
  cases: number;
  typeAccuracy: number;
  roleAccuracy: number;
  compatAccuracy: number;
  brandAccuracy: number;
  budgetAccuracy: number;
  attrPrecision: number;
  attrRecall: number;
  /** En az bir yanlis sert filtre iceren vaka orani. */
  falseHardFilterRate: number;
  unjudgedHardFilters: number;
  intentPreservation: number;
  reversedCases: number;
  clarifyAccuracy: number;
}

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

export function summarize(rows: readonly IntentV2Row[]): IntentV2Summary {
  const count = (pred: (r: IntentV2Row) => boolean) => rows.filter(pred).length;
  const tp = rows.reduce((s, r) => s + r.attrTp, 0);
  const fp = rows.reduce((s, r) => s + r.attrFp, 0);
  const fn = rows.reduce((s, r) => s + r.attrFn, 0);
  return {
    cases: rows.length,
    typeAccuracy: rate(
      count((r) => r.type),
      rows.length,
    ),
    roleAccuracy: rate(
      count((r) => r.role),
      rows.length,
    ),
    compatAccuracy: rate(
      count((r) => r.compat),
      rows.length,
    ),
    brandAccuracy: rate(
      count((r) => r.brand),
      rows.length,
    ),
    budgetAccuracy: rate(
      count((r) => r.budget),
      rows.length,
    ),
    attrPrecision: rate(tp, tp + fp),
    attrRecall: rate(tp, tp + fn),
    falseHardFilterRate: rate(
      count((r) => r.falseHard.length > 0),
      rows.length,
    ),
    unjudgedHardFilters: rows.reduce((s, r) => s + r.unjudgedHard.length, 0),
    intentPreservation: rate(
      count((r) => r.preserved),
      rows.length,
    ),
    reversedCases: count((r) => r.reversed.length > 0),
    clarifyAccuracy: rate(
      count((r) => r.clarify),
      rows.length,
    ),
  };
}

export function summarizeBy(
  rows: readonly IntentV2Row[],
  key: (row: IntentV2Row) => string,
): Record<string, IntentV2Summary> {
  const groups = new Map<string, IntentV2Row[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return Object.fromEntries([...groups].map(([k, g]) => [k, summarize(g)]));
}

/** Degerlendirmede kullanilan sozluk varsayimi: siniflandirma fixture'i + setin marka listesi. */
export function brandEntries(brands: readonly string[]): LexiconEntry[] {
  return brands.map((b) => ({ kind: "brand" as const, surface: b, normalized: b, weight: 1 }));
}
