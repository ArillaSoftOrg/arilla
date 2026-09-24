/**
 * Serbest metinden, soru sormadan bilinebilecek her seyi cikarir: domain,
 * faset secimleri, butce, yas, fiyat tercihi ve mevcut sozluk
 * ayristiricisinin (Kademe 2) renk/beden/marka sinyalleri.
 *
 * Saf fonksiyon: DB, ag, model cagrisi yok. Ayni girdi her zaman ayni ciktiyi
 * verir - durum gecisleri bu yuzden deterministiktir.
 *
 * Tetikleyici eslemesi token duzeyindedir ve Turkce harfleri ASCII'ye katlar:
 * kullanici "kosu ayakkabisi" da yazar "koşu ayakkabısı" da.
 */
import type { LexiconEntry } from "../search/lexicon.ts";
import { foldTurkish } from "../search/normalize.ts";
import { parseQueryText } from "../search/parse-query.ts";
import { extractPricePatterns } from "../search/price-patterns.ts";
import type {
  ClarificationRegistry,
  DomainDefinition,
  FacetDefinition,
  LexicalSignals,
} from "./types.ts";

const ASCII_FOLD: Readonly<Record<string, string>> = {
  ı: "i",
  ş: "s",
  ç: "c",
  ğ: "g",
  ö: "o",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Turkce kucuk harf + ASCII katlama. Karakter karakter, uzunluk korunur. */
export function foldForTrigger(text: string): string {
  return foldTurkish(text).replace(/[ışçğöüâîû]/g, (ch) => ASCII_FOLD[ch] ?? ch);
}

const WORD_SPLIT_RE = /[^\p{L}\p{N}]+/u;

/** Konusma dolgusu: aramaya girmez, sinyal de sayilmaz. ASCII katli. */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "ariyorum",
  "ariyom",
  "arayisindayim",
  "istiyorum",
  "istiyom",
  "bakiyorum",
  "bakiyom",
  "bakicam",
  "lazim",
  "almak",
  "alacagim",
  "alicam",
  "almayi",
  "dusunuyorum",
  "icin",
  "bir",
  "bi",
  "sey",
  "seyler",
  "bisey",
  "birsey",
  "birseyler",
  "ve",
  "ile",
  "olsun",
  "olsa",
  "olmali",
  "aslinda",
  "bana",
  "onerir",
  "oner",
  "oneri",
  "misin",
  "misiniz",
  "mi",
  "mu",
  "var",
  "en",
  "iyi",
  "guzel",
  "lutfen",
  "tane",
  "bu",
  "su",
  "da",
  "de",
  "ya",
  "tamam",
  "peki",
  "evet",
  "sadece",
  "biraz",
  "daha",
  "seviyor",
  "sever",
  "hoslanir",
  "hoslaniyor",
  "ilgileniyor",
  "meraklisi",
  "kullanacagim",
  "kullanicam",
  "yok",
  "tl",
  "lira",
]);

/** "ucuz" bir sayiya cevrilmez; yalnizca tercih olarak saklanir. */
const PRICE_PREFERENCE_TRIGGERS: readonly string[] = [
  "ucuz*",
  "uygun fiyat*",
  "hesaplı",
  "ekonomik",
  "fiyatı uygun",
  "bütçe dostu",
];

/**
 * Mevcut `extractPricePatterns`'in kapsamadigi konusma kaliplari:
 * "1000 liraya", "500 tl'ye", "750 liralık", "2000 tl üstü".
 */
const PRICE_AROUND_RE =
  /(\d[\d.]*)\s*(?:tl|lira|₺)\s*'?(?:ya|ye|yı|yi|lık|lik|luk|lük)?(?=\s|$|[.,!?])/gu;
const PRICE_ABOVE_RE = /(\d[\d.]*)\s*(?:tl|lira|₺)?\s*(?:üstü|üzeri|üzerinde|ve üzeri)/gu;
const AGE_RE = /(\d{1,2})\s*ya[sş]\p{L}*/gu;

export interface Token {
  /** Turkce kucuk harf bicimi (sozluk ayristiricisi bunu bekler). */
  lower: string;
  /** Tetikleyici eslemesi icin ASCII katli bicim. */
  folded: string;
}

export interface TriggerMatch {
  start: number;
  /** Haric. */
  end: number;
}

interface CompiledTrigger {
  words: readonly string[];
  wildcard: boolean;
}

function compileTrigger(trigger: string): CompiledTrigger | null {
  const wildcard = trigger.endsWith("*");
  const body = wildcard ? trigger.slice(0, -1) : trigger;
  const words = foldForTrigger(body).split(WORD_SPLIT_RE).filter(Boolean);
  if (words.length === 0) return null;
  return { words, wildcard };
}

/** Bir tetikleyicinin token dizisindeki tum gecisleri. */
export function findTriggerMatches(tokens: readonly Token[], trigger: string): TriggerMatch[] {
  const compiled = compileTrigger(trigger);
  if (compiled === null) return [];
  const { words, wildcard } = compiled;
  const matches: TriggerMatch[] = [];
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    const ok = words.every((word, j) => {
      const token = tokens[i + j]?.folded ?? "";
      const isLast = j === words.length - 1;
      return isLast && wildcard ? token.startsWith(word) : token === word;
    });
    if (ok) matches.push({ start: i, end: i + words.length });
  }
  return matches;
}

function anyTriggerMatches(tokens: readonly Token[], triggers: readonly string[]): TriggerMatch[] {
  return triggers.flatMap((trigger) => findTriggerMatches(tokens, trigger));
}

function tokenize(lower: string): Token[] {
  return lower
    .split(WORD_SPLIT_RE)
    .filter(Boolean)
    .map((word) => ({ lower: word, folded: foldForTrigger(word) }));
}

function parseTryAmount(raw: string): number | null {
  const value = Number.parseInt(raw.replace(/\./g, ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

export interface ExtractedBudget {
  minKurus: number | null;
  maxKurus: number | null;
}

export interface ExtractedFacts {
  /** Secilen birincil domain. */
  domainId: string | null;
  /** Birincil disinda eslesen domain'ler ("babama hediye kask" -> gift). */
  secondaryDomainIds: readonly string[];
  /** facetId -> optionId, yalnizca birincil domain'in fasetleri. */
  facets: Readonly<Record<string, string>>;
  budget: ExtractedBudget | null;
  age: number | null;
  pricePreference: "lower" | null;
  lexical: LexicalSignals;
  /** Hicbir kurala dusmeyen somut kelimeler. */
  terms: readonly string[];
}

export interface ExtractContext {
  registry: ClarificationRegistry;
  /** Kademe 2 sozlugu (renk, marka, beden). Bos olabilir. */
  lexicon: readonly LexiconEntry[];
}

export interface ExtractOptions {
  /**
   * Suren konusmanin domain'i. Takip metni ("babam için", "açık olsun")
   * kendi basina domain tetiklemez; fasetleri bu domain'e gore okunur.
   */
  contextDomainId?: string | null;
}

function extractBudget(lower: string): { budget: ExtractedBudget | null; rest: string } {
  let rest = lower;
  let minKurus: number | null = null;
  let maxKurus: number | null = null;
  let found = false;

  // Once mevcut arama kaliplari - ayni anlami tek yerde tutmak icin.
  for (const match of extractPricePatterns(lower)) {
    found = true;
    if (match.priceMin !== undefined) minKurus = match.priceMin;
    if (match.priceMax !== undefined) maxKurus = match.priceMax;
    // `alt(?:ı|ında)` alternasyonu "altında"nin yalnizca "altı" kismini
    // yakalar; kelimenin kalani ("nda") metin kapisina sizmasin.
    let end = match.end;
    while (end < rest.length && /\p{L}/u.test(rest[end] ?? "")) end += 1;
    rest = blank(rest, match.start, end);
  }

  for (const m of rest.matchAll(PRICE_ABOVE_RE)) {
    const amount = parseTryAmount(m[1] ?? "");
    if (amount === null) continue;
    found = true;
    minKurus = amount * 100;
    rest = blank(rest, m.index, m.index + m[0].length);
  }

  for (const m of rest.matchAll(PRICE_AROUND_RE)) {
    const amount = parseTryAmount(m[1] ?? "");
    if (amount === null) continue;
    found = true;
    // "1000 liraya" bir tavan olarak okunur; alt sinir uydurulmaz.
    maxKurus = amount * 100;
    rest = blank(rest, m.index, m.index + m[0].length);
  }

  return { budget: found ? { minKurus, maxKurus } : null, rest };
}

function extractAge(lower: string): { age: number | null; rest: string } {
  let rest = lower;
  let age: number | null = null;
  for (const m of lower.matchAll(AGE_RE)) {
    const value = Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(value) && value >= 0 && value < 100) age = value;
    rest = blank(rest, m.index, m.index + m[0].length);
  }
  return { age, rest };
}

/**
 * Birincil domain: blocker'i olmayan eslesmeler arasindan urun domain'leri
 * niyet domain'lerinden once gelir ("babama hediye kask" bir kask
 * aramasidir). Ayni turde en sondaki eslesme kazanir - Turkce tamlamada bas
 * isim sondadir.
 */
function detectDomains(
  tokens: readonly Token[],
  registry: ClarificationRegistry,
): { primary: DomainDefinition | null; secondary: DomainDefinition[] } {
  const hits: { domain: DomainDefinition; lastStart: number }[] = [];
  for (const domain of registry.domains) {
    const matches = anyTriggerMatches(tokens, domain.triggers);
    if (matches.length === 0) continue;
    if (domain.blockers && anyTriggerMatches(tokens, domain.blockers).length > 0) continue;
    hits.push({ domain, lastStart: Math.max(...matches.map((m) => m.start)) });
  }
  hits.sort((a, b) => {
    const kindRank = (d: DomainDefinition) => (d.kind === "product" ? 0 : 1);
    return kindRank(a.domain) - kindRank(b.domain) || b.lastStart - a.lastStart;
  });
  const [first, ...rest] = hits;
  return { primary: first?.domain ?? null, secondary: rest.map((hit) => hit.domain) };
}

function consume(consumed: boolean[], match: TriggerMatch): void {
  for (let i = match.start; i < match.end; i += 1) consumed[i] = true;
}

function isFree(consumed: readonly boolean[], match: TriggerMatch): boolean {
  for (let i = match.start; i < match.end; i += 1) if (consumed[i]) return false;
  return true;
}

/**
 * Bir fasetin secenek eslesmeleri: once en uzun yuzey ("kız arkadaş" >
 * "arkadaş"), cakisanlar elenir; birden fazla secenek kalirsa metinde en
 * sonda gecen kazanir ("kapalı değil, açık olsun" -> açık).
 */
function matchFacet(
  tokens: readonly Token[],
  facet: FacetDefinition,
  consumed: readonly boolean[],
): { optionId: string; matches: TriggerMatch[] } | null {
  const candidates = facet.options.flatMap((option) =>
    option.triggers.flatMap((trigger) =>
      findTriggerMatches(tokens, trigger).map((match) => ({ optionId: option.id, match })),
    ),
  );
  candidates.sort(
    (a, b) =>
      b.match.end - b.match.start - (a.match.end - a.match.start) || a.match.start - b.match.start,
  );

  const local = [...consumed];
  const accepted: { optionId: string; match: TriggerMatch }[] = [];
  for (const candidate of candidates) {
    if (!isFree(local, candidate.match)) continue;
    consume(local, candidate.match);
    accepted.push(candidate);
  }
  if (accepted.length === 0) return null;

  const latest = accepted.reduce((best, current) =>
    current.match.start > best.match.start ? current : best,
  );
  return { optionId: latest.optionId, matches: accepted.map((a) => a.match) };
}

function lexicalFromParse(filters: ReturnType<typeof parseQueryText>["filters"]): LexicalSignals {
  const lexical: LexicalSignals = {};
  if (filters.color && filters.color.length > 0) lexical.color = [...filters.color];
  if (filters.size_norm !== undefined) lexical.size_norm = filters.size_norm;
  if (filters.brand_include && filters.brand_include.length > 0) {
    lexical.brand_include = [...filters.brand_include];
  }
  if (filters.brand_exclude && filters.brand_exclude.length > 0) {
    lexical.brand_exclude = [...filters.brand_exclude];
  }
  if (filters.category_path !== undefined) lexical.category_path = filters.category_path;
  return lexical;
}

export function extractFacts(
  text: string,
  context: ExtractContext,
  options: ExtractOptions = {},
): ExtractedFacts {
  const lowered = foldTurkish(text).replace(/\s+/g, " ").trim();
  const afterBudget = extractBudget(lowered);
  const afterAge = extractAge(afterBudget.rest);
  const tokens = tokenize(afterAge.rest);
  const consumed = new Array<boolean>(tokens.length).fill(false);

  let pricePreference: "lower" | null = null;
  for (const match of anyTriggerMatches(tokens, PRICE_PREFERENCE_TRIGGERS)) {
    pricePreference = "lower";
    consume(consumed, match);
  }

  const detected = detectDomains(tokens, context.registry);
  const contextDomain =
    context.registry.domains.find((d) => d.id === options.contextDomainId) ?? null;
  const primary = detected.primary ?? contextDomain;
  const secondary = detected.secondary;
  const facets: Record<string, string> = {};

  for (const domain of [primary, ...secondary]) {
    if (domain === null) continue;
    for (const match of anyTriggerMatches(tokens, domain.triggers)) consume(consumed, match);
    for (const match of anyTriggerMatches(tokens, domain.fillerTerms ?? []))
      consume(consumed, match);
  }

  // Birincil domain'in fasetleri kaydedilir; ikincil domain'lerinki yalnizca
  // tuketilir ki "babama" gibi kelimeler metin kapisini bozmasin.
  for (const domain of [primary, ...secondary]) {
    if (domain === null) continue;
    const isPrimary = domain === primary;
    for (const facet of domain.facets) {
      const found = matchFacet(tokens, facet, consumed);
      if (found === null) continue;
      if (isPrimary && facets[facet.id] === undefined) facets[facet.id] = found.optionId;
      for (const match of found.matches) consume(consumed, match);
    }
  }

  if (primary !== null && afterAge.age !== null) {
    const ageFacet = primary.facets.find((facet) => facet.options.some((o) => o.ageRange));
    const band = ageFacet?.options.find(
      (option) =>
        option.ageRange !== undefined &&
        afterAge.age !== null &&
        afterAge.age >= option.ageRange[0] &&
        afterAge.age <= option.ageRange[1],
    );
    if (ageFacet && band) facets[ageFacet.id] = band.id;
  }

  const residual = tokens
    .filter((token, i) => !consumed[i] && !FILLER_WORDS.has(token.folded))
    .map((token) => token.lower);

  // Renk, beden, marka: mevcut Kademe 2 ayristiricisi. Kopya kural yazilmaz.
  const parsed = parseQueryText(residual.join(" "), context.lexicon, { minConfidence: 0 });
  const terms = parsed.unparsed.split(" ").filter(Boolean);

  return {
    domainId: primary?.id ?? null,
    secondaryDomainIds: secondary.map((domain) => domain.id),
    facets,
    budget: afterBudget.budget,
    age: afterAge.age,
    pricePreference,
    lexical: lexicalFromParse(parsed.filters),
    terms,
  };
}
