/**
 * Kosullu hybrid siralama (E4, BGE-M3): anlamsal arama lexical aramanin DOGRU sonuclarini
 * alakasiz yakin vektorlerle degistirmesin, ama lexical'in bos/zayif kaldigi yerde katki versin.
 * Saf fonksiyon (veritabani/model yok). Mevcut `fuseForQuery` DEGISMEZ; bu modul ayri ve olculur.
 *
 * Neden (E4 tanisi, `docs/.../E4-hybrid-gelistirme.md`):
 * - BGE-M3'te alakasiz urunler de 0,45–0,61 kosinus alir; Jina icin secilmis `minSimilarity` 0,3
 *   her adayi gecirir. Kosinus, ayni sorgu icinde bile alaka sirasi DEGILDIR (dogru lexical
 *   urunler 0,34–0,49, ilgisiz anlamsal urunler 0,50–0,61). Tek evrensel esik cozum degildir.
 * - Bu yuzden karar, kosinusun yaninda alakadan BAGIMSIZ isaretlere dayanir:
 *   1. Lexical eslesme duzeyi (`exact` = sorgunun butun terimleri baslikta): guclu lexical sonuc
 *      ust siralarda korunur; anlamsal aday yalniz ardindan ve sorgu-ici goreli esikle girer.
 *   2. Aday temizligi (yalniz ANLAMSAL-YALNIZ adaylara; lexical sonuc silinmez):
 *      gurultu baslik, sorgudaki model/teknik kodun baslikta olmamasi, olumsuzlanan ozellik,
 *      sorgudaki ozelligin karsiti (kablolu <-> kablosuz).
 *   3. Lexical bossa anlamsal sonuc ancak modele ozgu kalibre esigi gecerse ANA listeye girer;
 *      gecmezse ana liste bostur, adaylar ayri "benzer oneriler" olarak doner (dogru etiketle).
 * - Dogrulanmamis ozellik kesin filtreye DONUSMEZ: kurallar yalniz anlamsal EKLEMEYI reddeder ya da
 *   lexical sonucu asagi tasir; lexical sonuc kumesini daraltmaz.
 */
import { ATTRIBUTE_VALUES, oppositeOf } from "../../intent/antonyms.ts";
import type { LexiconEntry } from "../lexicon.ts";
import { foldForMatch } from "../text-match.ts";
import { looksLikeAccessory, queryWantsAccessory } from "./accessory-guard.ts";

export type LexicalTier = "exact" | "close" | "related" | null;

export interface PolicyTextItem {
  productId: number;
  title: string;
  tier: LexicalTier;
  /** Lexical urunun sorgu vektorune kosinusu (vektoru yoksa null). */
  similarity: number | null;
}

export interface PolicyCandidate {
  productId: number;
  title: string;
  similarity: number;
}

export interface HybridPolicy {
  /** Lexical "guclu" sayilmasi icin gereken `exact` duzeyli sonuc sayisi. */
  strongMinExact: number;
  /** Guclu lexical'de dokunulmayan ust sira sayisi. */
  strongKeep: number;
  /**
   * Guclu lexical'de anlamsal-yalniz adayin girmesi icin: kosinusu >= lexical kosinus ortancasi +
   * bu deger (sorgu ici goreli esik). null: goreli esik yok.
   */
  strongMinOverLexical: number | null;
  /** Zayif/kismi lexical'de anlamsal listenin RRF agirligi (lexical 1). */
  semanticWeight: number;
  /** Anlamsal aday en iyi adaydan en fazla bu kadar dusuk olabilir. */
  maxGapFromBest: number;
  /** En fazla anlamsal-yalniz urun. */
  maxSemanticOnly: number;
  /**
   * Guclu lexical icin ek kosul: lexical kosinus ortancasi >= en iyi anlamsal aday - bu deger
   * (sorgu ici goreli; lexical sonuclar anlamsal olarak da "yakin"). null: kosul yok.
   */
  strongMaxGapToDense: number | null;
  /**
   * Lexical bosken anlamsal adaylarin ANA listeye alinmasi icin en iyi adayin mutlak kosinusu.
   * null (varsayilan): hic alinmaz; adaylar yalniz ayri "benzer oneriler" olur. E4 olcumu: lexical
   * bos sorgularda alakali/alakasiz ayrimini tek kosinus esigi YAPAMIYOR (0,53–0,60 ortusuyor).
   */
  emptyMinTop: number | null;
  /** Olumsuzlanan ozelligi tasiyan LEXICAL sonucun puan carpani (silinmez). */
  negatedTextFactor: number;
  /**
   * Sorgu aksesuar istemiyorsa aksesuar gibi gorunen LEXICAL sonucun carpani (mevcut
   * `fuseForQuery` ile ayni deger, 0,3; silinmez, asagi tasinir).
   */
  accessoryTextFactor: number;
  rrfK: number;
}

/**
 * Varsayilan: E4 gelistirme kumesinde (49 sorgu) 2.916'lik izgaradan secildi; dogrulama kumesi
 * (31 sorgu) secimde KULLANILMADI. Puanlar AI destekli on degerlendirmedir (insan dogrulamasi yok).
 */
export const BGE_M3_HYBRID_POLICY: HybridPolicy = {
  strongMinExact: 3,
  strongKeep: 3,
  strongMinOverLexical: 0.05,
  strongMaxGapToDense: 0.15,
  semanticWeight: 1,
  maxGapFromBest: 0.08,
  maxSemanticOnly: 10,
  emptyMinTop: null,
  negatedTextFactor: 0.2,
  accessoryTextFactor: 0.3,
  rrfK: 60,
};

export type HybridMode =
  | "lexical_strong"
  | "blend"
  | "semantic_only"
  /** Lexical bos: ana liste bos, adaylar `suggestions` ("benzer oneriler") olarak. */
  | "suggestions_only";

export type RejectReason =
  | "noise"
  | "spec_missing"
  | "negated"
  | "opposite_attribute"
  | "accessory";

export interface HybridEntry {
  productId: number;
  title: string;
  source: "text" | "semantic" | "both";
  score: number;
  similarity: number | null;
}

export interface HybridResult {
  mode: HybridMode;
  ranked: HybridEntry[];
  /** Ana listeye girmeyen, "benzer oneriler" olarak AYRI gosterilebilecek adaylar. */
  suggestions: PolicyCandidate[];
  rejected: Partial<Record<RejectReason, number>>;
}

// --- aday temizligi -----------------------------------------------------------------------

/** Urun olmayan ilan kaliplari (odeme farki, kargo linki, stok yok vb.); katlanmis metinde. */
const NOISE_PHRASES =
  /\b(top up|balance|price difference|make up (the )?difference|extra fee|shipping (fee|cost|link)|postage|freight|deposit|no stock|out of stock|payment link|custom link|special link|vip link|dropshipping link|not for sale)\b/;

const words = (folded: string) => folded.split(/[^a-z0-9]+/).filter(Boolean);

export function isNoiseTitle(title: string): boolean {
  const folded = foldForMatch(title);
  if (NOISE_PHRASES.test(folded)) return true;
  const tokens = words(folded);
  const alpha = tokens.filter((t) => /[a-z]{2,}/.test(t));
  if (alpha.length < 3) return true;
  if (tokens.length >= 6 && new Set(tokens).size / tokens.length < 0.5) return true;
  return false;
}

/** Bosluk/tire/nokta duyarsiz karsilastirma: "16 GB" == "16gb", "M.2" == "m2". */
const compact = (s: string) => foldForMatch(s).replace(/[\s\-_./]+/g, "");

/**
 * Sorgudaki model/teknik kodlar: hem harf hem rakam iceren tokenlar (ddr5, 32gb, 20v, bl1830,
 * dcd771, ht170ex1). Saf sayi (fiyat, adet) ve tek karakter dahil edilmez.
 */
export function specTokens(queryText: string): string[] {
  const out = new Set<string>();
  for (const token of foldForMatch(queryText).split(/[\s,;:()/]+/)) {
    const t = token.replace(/[^a-z0-9.-]/g, "");
    if (t.length >= 2 && /[a-z]/.test(t) && /\d/.test(t)) out.add(compact(t));
  }
  return [...out];
}

const NEGATION = /(\S+)\s+(?:olmayan|olmasin|olmayanlar|degil|haric|disinda)\b/g;

/** Katlanmis ifadenin basliktaki kelime sinirli varligi. */
function containsPhrase(foldedTitle: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(foldedTitle);
}

function synonymGroup(term: string, lexicon: readonly LexiconEntry[]): Set<string> {
  const group = new Set<string>([term]);
  const keys = new Set(
    lexicon.filter((e) => foldForMatch(e.surface) === term).map((e) => e.normalized),
  );
  for (const entry of lexicon) {
    if (keys.has(entry.normalized)) group.add(foldForMatch(entry.surface));
  }
  for (const def of ATTRIBUTE_VALUES) {
    if (def.terms.some((t) => foldForMatch(t) === term)) {
      for (const t of def.terms) group.add(foldForMatch(t));
    }
  }
  return group;
}

/** "X olmayan / X degil / X haric" -> X ve sozluk/ozellik esanlamlilari (katlanmis). */
export function negatedTerms(queryText: string, lexicon: readonly LexiconEntry[]): Set<string> {
  const out = new Set<string>();
  for (const match of foldForMatch(queryText).matchAll(NEGATION)) {
    const term = match[1];
    if (term) for (const t of synonymGroup(term, lexicon)) out.add(t);
  }
  return out;
}

/** Sorguda OLUMSUZLANMADAN gecen kapali ozelliklerin karsit terimleri (kablolu -> wireless...). */
export function oppositeTerms(queryText: string, negated: ReadonlySet<string>): Set<string> {
  const folded = foldForMatch(queryText);
  const out = new Set<string>();
  for (const def of ATTRIBUTE_VALUES) {
    const present = def.terms.some(
      (t) => containsPhrase(folded, foldForMatch(t)) && !negated.has(foldForMatch(t)),
    );
    if (!present) continue;
    const other = oppositeOf(def);
    if (other) for (const t of other.terms) out.add(foldForMatch(t));
  }
  return out;
}

export interface CandidateCheck {
  specs: readonly string[];
  negated: ReadonlySet<string>;
  opposite: ReadonlySet<string>;
  /** Sorgu aksesuar istemiyor: aksesuar gorunumlu anlamsal aday eklenmez (mevcut koruma). */
  accessoryGuard: boolean;
}

export function buildCandidateCheck(
  queryText: string,
  lexicon: readonly LexiconEntry[],
): CandidateCheck {
  const negated = negatedTerms(queryText, lexicon);
  return {
    specs: specTokens(queryText),
    negated,
    opposite: oppositeTerms(queryText, negated),
    accessoryGuard: !queryWantsAccessory(queryText),
  };
}

export function rejectReason(title: string, check: CandidateCheck): RejectReason | null {
  if (isNoiseTitle(title)) return "noise";
  const folded = foldForMatch(title);
  if (check.specs.length > 0) {
    const flat = compact(title);
    if (!check.specs.every((s) => flat.includes(s))) return "spec_missing";
  }
  for (const t of check.negated) if (containsPhrase(folded, t)) return "negated";
  for (const t of check.opposite) if (containsPhrase(folded, t)) return "opposite_attribute";
  if (check.accessoryGuard && looksLikeAccessory(title)) return "accessory";
  return null;
}

// --- siralama -----------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function conditionalHybrid(
  text: readonly PolicyTextItem[],
  candidates: readonly PolicyCandidate[],
  check: CandidateCheck,
  policy: HybridPolicy = BGE_M3_HYBRID_POLICY,
): HybridResult {
  const textIds = new Set(text.map((t) => t.productId));
  const rejected: Partial<Record<RejectReason, number>> = {};
  const clean: PolicyCandidate[] = [];
  for (const c of [...candidates].sort(
    (a, b) => b.similarity - a.similarity || a.productId - b.productId,
  )) {
    if (textIds.has(c.productId)) {
      clean.push(c);
      continue;
    }
    const reason = rejectReason(c.title, check);
    if (reason) rejected[reason] = (rejected[reason] ?? 0) + 1;
    else clean.push(c);
  }
  const best = clean[0]?.similarity;
  const window = clean.filter(
    (c) => best !== undefined && best - c.similarity <= policy.maxGapFromBest,
  );
  const semanticOnly = window
    .filter((c) => !textIds.has(c.productId))
    .slice(0, policy.maxSemanticOnly);
  const confirmations = new Map(
    window.filter((c) => textIds.has(c.productId)).map((c) => [c.productId, c]),
  );

  if (text.length === 0) {
    const confident =
      policy.emptyMinTop !== null && best !== undefined && best >= policy.emptyMinTop;
    if (!confident) {
      return { mode: "suggestions_only", ranked: [], suggestions: semanticOnly, rejected };
    }
    return {
      mode: "semantic_only",
      ranked: semanticOnly.map((c, i) => ({
        productId: c.productId,
        title: c.title,
        source: "semantic",
        score: 1 / (policy.rrfK + i + 1),
        similarity: c.similarity,
      })),
      suggestions: [],
      rejected,
    };
  }

  const negatedText = (t: PolicyTextItem) =>
    [...check.negated].some((n) => containsPhrase(foldForMatch(t.title), n));
  const accessoryText = (t: PolicyTextItem) => check.accessoryGuard && looksLikeAccessory(t.title);
  const textFactor = (t: PolicyTextItem) =>
    (negatedText(t) ? policy.negatedTextFactor : 1) *
    (accessoryText(t) ? policy.accessoryTextFactor : 1);
  // Olumsuzlanan ozelligi ya da aksesuar gorunumu olan lexical sonuc silinmez, asagi tasinir.
  const orderedText = [
    ...text.filter((t) => textFactor(t) === 1),
    ...text.filter((t) => textFactor(t) !== 1),
  ];
  const k = policy.rrfK;
  const exactCount = text.filter((t) => t.tier === "exact").length;
  const lexSims = text.map((t) => t.similarity).filter((s): s is number => s !== null);
  const lexMedianAll = median(lexSims);
  const nearDense =
    policy.strongMaxGapToDense === null ||
    best === undefined ||
    (lexMedianAll !== null && lexMedianAll >= best - policy.strongMaxGapToDense);
  const strong = exactCount >= policy.strongMinExact && nearDense;

  if (strong) {
    const keep = orderedText.slice(0, policy.strongKeep);
    const restText = orderedText.slice(policy.strongKeep);
    const over = policy.strongMinOverLexical;
    const extra =
      over === null || lexMedianAll === null
        ? semanticOnly
        : semanticOnly.filter((c) => c.similarity >= lexMedianAll + over);
    const entries: HybridEntry[] = keep.map((t, i) => ({
      productId: t.productId,
      title: t.title,
      source: confirmations.has(t.productId) ? "both" : "text",
      score: 10 - i, // dokunulmayan blok her zaman ustte
      similarity: t.similarity,
    }));
    const tail = rrf(restText, extra, confirmations, policy.semanticWeight, k, textFactor);
    return { mode: "lexical_strong", ranked: [...entries, ...tail], suggestions: [], rejected };
  }
  return {
    mode: "blend",
    ranked: rrf(orderedText, semanticOnly, confirmations, policy.semanticWeight, k, textFactor),
    suggestions: [],
    rejected,
  };
}

function rrf(
  text: readonly PolicyTextItem[],
  semantic: readonly PolicyCandidate[],
  confirmations: ReadonlyMap<number, PolicyCandidate>,
  semanticWeight: number,
  k: number,
  textFactor: (t: PolicyTextItem) => number,
): HybridEntry[] {
  const entries: (HybridEntry & { textRank: number })[] = text.map((t, i) => {
    const confirmed = confirmations.get(t.productId);
    return {
      productId: t.productId,
      title: t.title,
      source: confirmed ? "both" : "text",
      // Anlamsal teyit lexical sonucu yukari tasir; ama tek basina siralamayi belirlemez.
      score: (1 / (k + i + 1)) * textFactor(t) + (confirmed ? semanticWeight / (k + i + 1) / 2 : 0),
      similarity: confirmed?.similarity ?? t.similarity,
      textRank: i,
    };
  });
  semantic.forEach((c, i) => {
    entries.push({
      productId: c.productId,
      title: c.title,
      source: "semantic",
      score: semanticWeight / (k + i + 1),
      similarity: c.similarity,
      textRank: Number.POSITIVE_INFINITY,
    });
  });
  // Esit puanda lexical once (eski RRF urun kimligiyle bozuyordu).
  return entries
    .sort((a, b) => b.score - a.score || a.textRank - b.textRank || a.productId - b.productId)
    .map(({ textRank: _r, ...e }) => e);
}
