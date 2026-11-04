/**
 * Normalizasyonun aramaya baglanmasi (karar 0172, Faz 2). Bayrak arkasindadir:
 * `QUERY_NORMALIZATION_MODE` = off (varsayilan) | shadow | on.
 *
 * Kurallar:
 * - Onbellek kimligi degismez. `resolveQuery`'nin dondurdugu (onbellekteki) `parsed` nesnesine
 *   dokunulmaz; duzeltmeler yalnizca KOPYASINA eklenir ve hicbir yere yazilmaz.
 * - Duzeltme bir ALTERNATIFTIR: ozgun token slotun ilk elemani olarak kalir, duzeltilmis bicim
 *   (ve onun `lexicon` es anlamlilari, orn. "sarj aleti" -> "charger") yanina eklenir. Dogru
 *   yazilmis urunler boylece kaybolmaz.
 * - Duzeltme sert filtreye donusmez (marka filtresi dahil); `filters` degismez.
 * - Olumsuzlanan kelime ("zamzung olmasin") aramada duzeltilmez: alternatif eklemek olumsuzlugu
 *   tersine cevirip o markayi aratirdi.
 * - Hata aramayi asla bozmaz: her hata ozgun `parsed` ile devam eder. Log yalnizca sayi ve sabit
 *   kod tasir; sorgu metni loglanmaz.
 */
import type { Database } from "@arilla/db";
import type { LexiconEntry } from "../lexicon.ts";
import { loadLexiconCached } from "../lexicon-cache.ts";
import type { Correction, NormalizedQuery } from "../normalized-query.ts";
import { textSlotsOf } from "../search-sql.ts";
import { buildTextSlots, foldForMatch, matchTokens } from "../text-match.ts";
import type { QueryObject } from "../types.ts";
import { type QueryNormalizationMode, queryNormalizationMode } from "./config.ts";
import { normalizeQuery } from "./index.ts";
import type { Vocabulary } from "./vocabulary.ts";
import { loadVocabularyCached } from "./vocabulary-repository.ts";

/** Ardindan gelince onceki kelimeyi olumsuzlayan isaretler (katlanmis). */
const NEGATION_MARKERS: ReadonlySet<string> = new Set([
  "olmasin",
  "olmayan",
  "haric",
  "degil",
  "disinda",
]);

/** Slot basina en fazla bu kadar duzeltmeden gelen alternatif (`to` dahil). */
export const MAX_CORRECTION_ALTERNATIVES = 2;

function negated(correction: Correction, normalized: NormalizedQuery): boolean {
  const index = normalized.tokens.findIndex((token) => token.span[0] === correction.span[0]);
  const next = normalized.tokens[index + 1];
  return next !== undefined && NEGATION_MARKERS.has(foldForMatch(next.text));
}

/** Aramada kullanilacak duzeltmeler: kodu koruyan ve olumsuzlanmayan. */
export function searchableCorrections(normalized: NormalizedQuery): Correction[] {
  return normalized.corrections.filter(
    (correction) => correction.preservesCodes && !negated(correction, normalized),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Duzeltmeleri `parsed`in kopyasindaki metin slotlarina alternatif olarak ekler. `normalized`
 * `parsed.unparsed` uzerinde hesaplanmis olmalidir. Uygulanacak duzeltme yoksa ya da token
 * hizalamasi bozulursa ozgun `parsed` nesnesi aynen doner.
 */
export function applyCorrectionsToParsed(
  parsed: QueryObject,
  normalized: NormalizedQuery,
  lexicon: readonly LexiconEntry[],
): QueryObject {
  if (normalized.raw !== parsed.unparsed) return parsed;
  const corrections = searchableCorrections(normalized);
  if (corrections.length === 0) return parsed;

  let correctedText = parsed.unparsed;
  for (const correction of [...corrections].sort((a, b) => b.span[0] - a.span[0])) {
    correctedText = `${correctedText.slice(0, correction.span[0])}${correction.to}${correctedText.slice(correction.span[1])}`;
  }
  const originalTokens = matchTokens(parsed.unparsed);
  const correctedTokens = matchTokens(correctedText);
  if (originalTokens.length !== correctedTokens.length) return parsed;

  // Duzeltilmis kelime (katlanmis) -> belirsizlik alternatifleri (katlanmis).
  const ambiguous = new Map<string, string[]>();
  for (const correction of corrections) {
    const extra = (correction.alternatives ?? [])
      .slice(0, MAX_CORRECTION_ALTERNATIVES - 1)
      .map((alt) => foldForMatch(alt.to));
    if (extra.length > 0) ambiguous.set(foldForMatch(correction.to), extra);
  }

  const correctedSlots = buildTextSlots(correctedText, lexicon);
  const merged: string[][] = [];
  let index = 0;
  for (const slot of correctedSlots) {
    const phrase = slot[0] as string;
    const width = phrase.split(" ").length;
    const original = originalTokens.slice(index, index + width).join(" ");
    index += width;
    if (original === phrase) {
      merged.push(slot);
      continue;
    }
    merged.push(unique([original, ...slot, ...(ambiguous.get(phrase) ?? [])]));
  }
  if (index !== originalTokens.length) return parsed;
  // Duzeltme yalniz yazimi degistirdi ve hicbir slot farkli degilse ozgun nesne kalir.
  const before = JSON.stringify(textSlotsOf(parsed));
  if (JSON.stringify(merged) === before) return parsed;
  return { ...parsed, text_slots: merged };
}

export interface NormalizeForSearchOptions {
  mode?: QueryNormalizationMode;
  log?: (line: string) => void;
  loadVocabulary?: (db: Database) => Promise<Vocabulary>;
  loadLexicon?: (db: Database) => Promise<LexiconEntry[]>;
  now?: () => number;
  /** `on` kipinde dagarcik/sozluk yuklemesinin istegi bekletebilecegi en uzun sure. */
  loadBudgetMs?: number;
  /** Test icin pencere sayaci; verilmezse surec ici ortak sayac. */
  stats?: NormalizationStats;
}

/**
 * `on` kipinde onbellek bosken yukleme (kategori + marka + sozluk) istegi en fazla bu kadar
 * bekletir; asilirsa bu istek duzeltmesiz devam eder, yukleme arka planda onbellegi isitir.
 */
export const NORMALIZATION_LOAD_BUDGET_MS = 250;

/** Bu kadar normalize edilen aramada bir ozet satiri loglanir (surec basina). */
export const NORMALIZATION_LOG_WINDOW = 200;

/**
 * Surec ici pencere sayaclari. Sorgu metni, duzeltme metni ya da kimlik TUTULMAZ; yalniz sayi.
 * Tetiklenme orani = triggered / searches.
 */
export class NormalizationStats {
  searches = 0;
  triggered = 0;
  corrections = 0;
  brand = 0;
  ambiguous = 0;
  applied = 0;
  errors = 0;
  timeouts = 0;
  private durations: number[] = [];
  private readonly window: number;
  private readonly log: (line: string) => void;

  // Parametre ozelligi (constructor(private ...)) kullanilmaz: `node scripts/*.ts` (tip ayiklama
  // kipi) bu modulu dogrudan yukler ve o sozdizimini desteklemez.
  constructor(
    window = NORMALIZATION_LOG_WINDOW,
    log: (line: string) => void = (line) => console.info(line),
  ) {
    this.window = window;
    this.log = log;
  }

  record(sample: {
    corrections: number;
    brand: number;
    ambiguous: number;
    applied: boolean;
    ms: number;
    version: string;
    mode: QueryNormalizationMode;
  }): void {
    this.searches += 1;
    if (sample.corrections > 0) this.triggered += 1;
    this.corrections += sample.corrections;
    this.brand += sample.brand;
    this.ambiguous += sample.ambiguous;
    if (sample.applied) this.applied += 1;
    this.durations.push(sample.ms);
    if (this.searches >= this.window) this.flush(sample.mode, sample.version);
  }

  error(kind: "error" | "timeout"): void {
    if (kind === "timeout") this.timeouts += 1;
    else this.errors += 1;
  }

  flush(mode: QueryNormalizationMode, version: string): void {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const p95 = sorted.length
      ? (sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number)
      : 0;
    this.log(
      `[normalize] mode=${mode} window=${this.searches} triggered=${this.triggered}` +
        ` corrections=${this.corrections} brand=${this.brand} ambiguous=${this.ambiguous}` +
        ` applied=${this.applied} errors=${this.errors} timeouts=${this.timeouts}` +
        ` p95ms=${p95.toFixed(2)} version=${version}`,
    );
    this.searches = 0;
    this.triggered = 0;
    this.corrections = 0;
    this.brand = 0;
    this.ambiguous = 0;
    this.applied = 0;
    this.errors = 0;
    this.timeouts = 0;
    this.durations = [];
  }
}

const sharedStats = new NormalizationStats();

class LoadTimeout extends Error {
  override name = "LoadTimeout";
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoadTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function compute(
  db: Database,
  parsed: QueryObject,
  mode: QueryNormalizationMode,
  options: NormalizeForSearchOptions,
  stats: NormalizationStats,
  budgetMs: number | null,
): Promise<QueryObject> {
  const now = options.now ?? (() => performance.now());
  const loading = Promise.all([
    (options.loadVocabulary ?? loadVocabularyCached)(db),
    (options.loadLexicon ?? loadLexiconCached)(db),
  ]);
  const [vocabulary, lexicon] = await (budgetMs === null ? loading : withBudget(loading, budgetMs));
  const started = now();
  const normalized = normalizeQuery(parsed.unparsed, vocabulary);
  const applied = applyCorrectionsToParsed(parsed, normalized, lexicon);
  stats.record({
    corrections: normalized.corrections.length,
    brand: normalized.corrections.filter((c) => c.kind === "brand").length,
    ambiguous: normalized.corrections.filter((c) => c.alternatives?.length).length,
    applied: applied !== parsed,
    ms: now() - started,
    version: normalized.normalizerVersion,
    mode,
  });
  return applied;
}

/**
 * `/ara` metin aramasinin tek giris noktasi.
 * - `off`: hicbir is yapilmaz, `parsed` aynen doner.
 * - `shadow`: `parsed` HEMEN aynen doner; normalizasyon istegi beklemeden arka planda hesaplanir
 *   ve yalniz pencere ozeti (sayi) loglanir. Kullaniciya giden sonuc ve gecikme degismez.
 * - `on`: duzeltmeler kopyaya eklenmis `parsed` doner; yukleme `loadBudgetMs`'i asarsa ya da
 *   hata olursa ozgun `parsed` ile devam edilir.
 */
export async function normalizeParsedForSearch(
  db: Database,
  parsed: QueryObject,
  options: NormalizeForSearchOptions = {},
): Promise<QueryObject> {
  const mode = options.mode ?? queryNormalizationMode();
  if (mode === "off" || parsed.unparsed.trim() === "") return parsed;
  const stats =
    options.stats ?? (options.log ? new NormalizationStats(1, options.log) : sharedStats);
  const fail = (error: unknown) => {
    stats.error(error instanceof LoadTimeout ? "timeout" : "error");
    (options.log ?? ((line: string) => console.info(line)))(
      `[normalize] skipped: ${error instanceof Error ? error.name : "unknown"}`,
    );
  };

  if (mode === "shadow") {
    void compute(db, parsed, mode, options, stats, null).catch(fail);
    return parsed;
  }
  try {
    return await compute(
      db,
      parsed,
      mode,
      options,
      stats,
      options.loadBudgetMs ?? NORMALIZATION_LOAD_BUDGET_MS,
    );
  } catch (error) {
    fail(error);
    return parsed;
  }
}
