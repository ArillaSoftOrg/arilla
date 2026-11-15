/**
 * IntentV2 alternatif arama terimleri (docs/decisions/0210).
 *
 * Model, sorgudaki bir kelime/ifade icin en fazla 3 es anlamli arama terimi onerebilir
 * (kaynak dil Turkce; hedef dil serbest, katalog Ingilizce agirlikli oldugundan genelde
 * Ingilizce). Terimler YALNIZ metin kapisinin aday bulmasinda, ilgili slota es anlamli olarak
 * eklenir. Siralamaya, BGE vektorune, kategoriye, filtreye ve marka kararina karismaz.
 *
 * Iki asamali dogrulama (saf; ag/veritabani yok):
 *  1. `validateAlternativeTerms` (sorguya ve sozluge gore): bicim, uzunluk, karakter, kisisel
 *     veri/URL/rakam, marka, aksesuar kaliplari, `for_text` kanit baglantisi.
 *  2. `mergeAlternativeTerms` (aramanin gercek slotlarina gore): kanit baglantisi bir slota
 *     denk gelmeli; tekrar/orijinalle ayni terim atilir; toplam ust sinir.
 * Hata ya da eksik alanda sonuc BOS listedir: arama bugunku gibi calisir.
 */
import { queryContentIneligibility } from "../search/interpretation-eligibility.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { normalizeQueryText } from "../search/normalize.ts";
import { mentionsAccessoryWord } from "../search/product-title-guard.ts";
import { looksLikeAccessory, queryWantsAccessory } from "../search/semantic/accessory-guard.ts";
import { foldForMatch, matchTokens } from "../search/text-match.ts";

export const MAX_ALTERNATIVE_TERMS = 3;
export const MAX_ALTERNATIVE_TERM_LENGTH = 40;
const MAX_ALTERNATIVE_TERM_WORDS = 3;
const MIN_WORD_LENGTH = 2;

/** Dogrulanmis terim: `forText` sorgudaki katlanmis kelime/ifadedir (kanit). */
export interface AlternativeTerm {
  text: string;
  forText: string;
  lang: string | null;
}

const URL_LIKE = /https?:|www\.|\.com\b|@/iu;
/** Yalniz harf (kesme/tire ici serbest); rakam, sembol, dizi reddedilir. */
const WORD = /^\p{L}[\p{L}'-]*\p{L}$/u;
const LANG = /^[a-z]{2,3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ham `alternative_terms` alaninin sorguya gore dogrulanmis hali. Slot eslemesi sonraki asamadadir.
 * Eksik/bozuk alan -> `[]` (eski kayitlar bu alani tasimaz).
 */
export function validateAlternativeTerms(
  raw: unknown,
  ctx: { queryText: string; lexicon: readonly LexiconEntry[] },
): AlternativeTerm[] {
  if (!isRecord(raw) || !Array.isArray(raw.alternative_terms)) return [];
  const queryFolded = foldForMatch(ctx.queryText).trim();
  const queryWords = new Set(matchTokens(ctx.queryText));
  const wantsAccessory = queryWantsAccessory(ctx.queryText);
  const brands = new Set(
    ctx.lexicon
      .filter((entry) => entry.kind === "brand")
      .flatMap((entry) => [
        foldForMatch(entry.surface).trim(),
        foldForMatch(entry.normalized).trim(),
      ]),
  );
  const out: AlternativeTerm[] = [];
  const seen = new Set<string>();
  for (const entry of raw.alternative_terms.slice(0, MAX_ALTERNATIVE_TERMS * 2)) {
    if (out.length >= MAX_ALTERNATIVE_TERMS) break;
    if (!isRecord(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    const forRaw = typeof entry.for_text === "string" ? entry.for_text.trim() : "";
    if (text.length < 3 || text.length > MAX_ALTERNATIVE_TERM_LENGTH || forRaw.length === 0)
      continue;
    if (URL_LIKE.test(text)) continue;
    const words = text.split(/\s+/);
    if (words.length > MAX_ALTERNATIVE_TERM_WORDS) continue;
    if (!words.every((word) => word.length >= MIN_WORD_LENGTH && WORD.test(word))) continue;
    const folded = words.map((word) => foldForMatch(word)).join(" ");
    // KVKK/kisisel veri/sir suzgeci: sorgu ile ayni kapidan gecer.
    if (queryContentIneligibility(normalizeQueryText(folded)) !== null) continue;
    if (folded === queryFolded || seen.has(folded)) continue;
    // Model yeni marka ekleyemez.
    if (brands.has(folded) || words.some((word) => brands.has(foldForMatch(word)))) continue;
    // Kullanici aksesuar istemediyse terim aksesuar/parca/arac alanina kayamaz.
    if (
      !wantsAccessory &&
      (queryWantsAccessory(folded) || looksLikeAccessory(folded) || mentionsAccessoryWord(folded))
    ) {
      continue;
    }
    // Kanit: sorgudan birebir (katlanmis) kelime/ifade.
    const forText = matchTokens(forRaw).join(" ");
    if (forText.length === 0 || !matchTokens(forRaw).every((word) => queryWords.has(word)))
      continue;
    const lang =
      typeof entry.lang === "string" && LANG.test(entry.lang.trim().toLowerCase())
        ? entry.lang.trim().toLowerCase()
        : null;
    seen.add(folded);
    out.push({ text: folded, forText, lang });
  }
  return out;
}

/**
 * Terimleri aramanin slotlarina es anlamli olarak ekler. Slot sirasi ve ilk (orijinal) alternatif
 * degismez; terim slotun SONUNA eklenir. `forText` hicbir slotun alternatifiyle birebir
 * eslesmezse terim atilir. Hicbir terim eklenemezse AYNI dizi nesnesi doner.
 */
export function mergeAlternativeTerms(
  slots: readonly (readonly string[])[],
  terms: readonly AlternativeTerm[],
): { slots: string[][]; added: AlternativeTerm[] } {
  const next = slots.map((slot) => [...slot]);
  const taken = new Set(next.flat());
  const added: AlternativeTerm[] = [];
  for (const term of terms) {
    if (added.length >= MAX_ALTERNATIVE_TERMS) break;
    if (taken.has(term.text)) continue;
    const slot = next.find((candidate) => candidate.includes(term.forText));
    if (slot === undefined) continue;
    slot.push(term.text);
    taken.add(term.text);
    added.push(term);
  }
  return { slots: next, added };
}
