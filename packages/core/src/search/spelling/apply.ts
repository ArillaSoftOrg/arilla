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
}

/**
 * `/ara` metin aramasinin tek giris noktasi. `off`: hicbir is yapilmaz, `parsed` aynen doner.
 * `shadow`: hesaplanir ve yalniz sayac loglanir, `parsed` aynen doner. `on`: duzeltmeler
 * kopyaya eklenmis `parsed` doner.
 */
export async function normalizeParsedForSearch(
  db: Database,
  parsed: QueryObject,
  options: NormalizeForSearchOptions = {},
): Promise<QueryObject> {
  const mode = options.mode ?? queryNormalizationMode();
  if (mode === "off" || parsed.unparsed.trim() === "") return parsed;
  const log = options.log ?? ((line: string) => console.info(line));
  const now = options.now ?? (() => performance.now());
  try {
    const [vocabulary, lexicon] = await Promise.all([
      (options.loadVocabulary ?? loadVocabularyCached)(db),
      (options.loadLexicon ?? loadLexiconCached)(db),
    ]);
    const started = now();
    const normalized = normalizeQuery(parsed.unparsed, vocabulary);
    const applied = applyCorrectionsToParsed(parsed, normalized, lexicon);
    const elapsed = now() - started;
    if (normalized.corrections.length > 0) {
      const ambiguousCount = normalized.corrections.filter((c) => c.alternatives?.length).length;
      log(
        `[normalize] mode=${mode} corrections=${normalized.corrections.length}` +
          ` ambiguous=${ambiguousCount} applied=${applied === parsed ? 0 : 1}` +
          ` ms=${elapsed.toFixed(2)} version=${normalized.normalizerVersion}`,
      );
    }
    return mode === "on" ? applied : parsed;
  } catch (error) {
    log(`[normalize] skipped: ${error instanceof Error ? error.name : "unknown"}`);
    return parsed;
  }
}
