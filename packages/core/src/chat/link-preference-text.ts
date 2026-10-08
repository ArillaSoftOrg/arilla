/**
 * Link aramasının tercih metni (karar 0079) — saf fonksiyonlar. Yeni sözlük yok:
 * renk, stil ve malzeme mevcut `lexicon`dan; fiyat mevcut konuşma-dili fiyat
 * ve `price-patterns` kalıplarından; "daha uygun fiyatlı" ve "fiyat sınırını
 * kaldır" `fallbackTurn`ün kalıplarından gelir.
 *
 * Tanınmayan anlamlı sözcükler `leftover` olarak döner; yalnızca bunlar (ve
 * yalnızca `CHAT_LINK_INTERPRET_ENABLED` açıkken) modele gidebilir.
 */
import { extractConversationalBudget } from "../clarification/price-language.ts";
import { hasLinkPreferences, type LinkPreferences } from "../discovery/index.ts";
import { findLexiconMatches, type LexiconEntry } from "../search/lexicon.ts";
import { foldTurkish, normalizeQueryText } from "../search/normalize.ts";
import { extractPricePatterns } from "../search/price-patterns.ts";
import type { SearchIntentPatch } from "./contract.ts";
import { CHEAPER_RE, REMOVE_PRICE_RE } from "./interpreter.ts";
import { sanitizeLinkPreferences } from "./link.ts";

export interface ParsedLinkPreferences {
  /** Bu mesajdan tanınanlar (kuruş / kanonik etiket). */
  preferences: LinkPreferences;
  /** "fiyat sınırını kaldır". */
  clearPrice: boolean;
  /** Tanınmayan anlamlı sözcükler (durak sözcük, sayısız noktalama, URL hariç). */
  leftover: string[];
  /** Kategori/marka/beden eşleşmeleri: bunlar tercih değil, yeni konu işaretidir. */
  topicWords: string[];
  /** Tanınan en az bir tercih ya da fiyat kaldırma var mı. */
  recognized: boolean;
}

/** Tercih anlamı taşımayan, günlük konuşma sözcükleri (katlanmış). */
const STOP_WORDS = new Set(
  [
    "bir",
    "bu",
    "şu",
    "o",
    "ve",
    "ile",
    "ama",
    "fakat",
    "ya",
    "da",
    "de",
    "ki",
    "mi",
    "mı",
    "mu",
    "mü",
    "olsun",
    "olmasın",
    "olur",
    "olabilir",
    "istiyorum",
    "isterim",
    "ister",
    "istedim",
    "bul",
    "bulur",
    "bana",
    "benim",
    "için",
    "göster",
    "gösterir",
    "ara",
    "arar",
    "arıyorum",
    "benzer",
    "benzerini",
    "benzerleri",
    "benzeri",
    "buna",
    "bunun",
    "bunu",
    "şunu",
    "gibi",
    "lütfen",
    "biraz",
    "daha",
    "çok",
    "en",
    "fiyat",
    "fiyatı",
    "fiyatlı",
    "fiyatta",
    "tl",
    "₺",
    "lira",
    "bütçe",
    "bütçem",
    "sınır",
    "sınırı",
    "sınırını",
    "kadar",
    "altı",
    "altında",
    "üstü",
    "üstünde",
    "arası",
    "olan",
    "olanları",
    "ürün",
    "ürünü",
    "link",
    "linki",
    "linkini",
    "bağlantı",
    "bağlantıyı",
    "aynı",
    "hangi",
    "var",
    "yok",
    "mı?",
    "evet",
    "hayır",
    "tamam",
    "merhaba",
    "selam",
    "teşekkürler",
    "sağol",
    "peki",
    "şimdi",
    "bak",
    "bakar",
    "kaldır",
    "sil",
    "iptal",
    "yerine",
    "ise",
    "veya",
    "ya da",
    "uygun",
    "ekonomik",
    "ucuz",
  ].map((word) => foldTurkish(word)),
);

const TOPIC_KINDS = new Set<LexiconEntry["kind"]>(["category", "brand", "size"]);
const PREFERENCE_KINDS: readonly LexiconEntry["kind"][] = [
  "color",
  "style",
  "material",
  "category",
  "brand",
  "size",
  "synonym",
];

function blank(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;
}

/**
 * Bağlantısız kullanıcı metninden tercihleri çıkarır. Model YOK. `lexicon`
 * boşsa renk/stil tanınmaz (bütün sözcükler `leftover` olur).
 */
export function parseLinkPreferences(
  text: string,
  lexicon: readonly LexiconEntry[],
): ParsedLinkPreferences {
  let rest = normalizeQueryText(text);
  const preferences: LinkPreferences = {};

  let clearPrice = false;
  if (REMOVE_PRICE_RE.test(rest)) {
    clearPrice = true;
    rest = rest.replace(REMOVE_PRICE_RE, " ");
  }
  if (CHEAPER_RE.test(rest)) {
    preferences.sort = "cheapest";
    rest = rest.replace(CHEAPER_RE, " ");
  }

  // Fiyat: `parseQueryText` ile aynı sıra (konuşma dili, sonra mevcut kalıplar).
  const conversational = extractConversationalBudget(rest);
  rest = conversational.rest;
  if (conversational.budget?.minKurus != null) {
    preferences.priceMinKurus = conversational.budget.minKurus;
  }
  if (conversational.budget?.maxKurus != null) {
    preferences.priceMaxKurus = conversational.budget.maxKurus;
  }
  for (const match of [...extractPricePatterns(rest)].reverse()) {
    if (match.priceMin !== undefined) preferences.priceMinKurus = match.priceMin;
    if (match.priceMax !== undefined) preferences.priceMaxKurus = match.priceMax;
    rest = blank(rest, match.start, match.end);
  }

  const colors: string[] = [];
  const styles: string[] = [];
  const topicWords: string[] = [];
  const entries = lexicon.filter((entry) => PREFERENCE_KINDS.includes(entry.kind));
  const matches = findLexiconMatches(rest, entries).sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const taken: { start: number; end: number }[] = [];
  for (const match of matches) {
    if (taken.some((span) => match.start < span.end && span.start < match.end)) continue;
    taken.push({ start: match.start, end: match.end });
    const { kind, normalized } = match.entry;
    if (kind === "color") {
      if (!colors.includes(normalized)) colors.push(normalized);
    } else if (kind === "style" || kind === "material") {
      if (!styles.includes(normalized)) styles.push(normalized);
    } else if (TOPIC_KINDS.has(kind)) {
      topicWords.push(rest.slice(match.start, match.end));
    }
  }
  for (const span of [...taken].sort((a, b) => b.start - a.start)) {
    rest = blank(rest, span.start, span.end);
  }
  if (colors.length > 0) preferences.colors = colors.slice(0, 5);
  if (styles.length > 0) preferences.styles = styles.slice(0, 5);

  const leftover: string[] = [];
  for (const token of rest.split(/[^\p{L}\p{N}₺]+/u)) {
    if (token.length < 2 || STOP_WORDS.has(token) || leftover.includes(token)) continue;
    leftover.push(token);
  }
  // Marka/kategori sözcükleri tercih değil ama "anlaşılmadı" sayılır.
  for (const word of topicWords) {
    const folded = foldTurkish(word.trim());
    if (folded && !leftover.includes(folded)) leftover.push(folded);
  }

  const clean = sanitizeLinkPreferences(preferences);
  return {
    preferences: clean,
    clearPrice,
    leftover: leftover.slice(0, 12),
    topicWords,
    recognized: hasLinkPreferences(clean) || clearPrice,
  };
}

/**
 * Yeni tercihleri öncekiyle birleştirir. Yeni bir fiyat ifadesi fiyatı BÜTÜNÜYLE
 * değiştirir; renk ve stil değişir (eklenmez); sıralama yapışkandır;
 * "fiyat sınırını kaldır" fiyatı temizler.
 */
export function mergeLinkPreferences(
  previous: LinkPreferences,
  parsed: Pick<ParsedLinkPreferences, "preferences" | "clearPrice">,
): LinkPreferences {
  const next: LinkPreferences = { ...previous };
  const incoming = parsed.preferences;
  if (parsed.clearPrice) {
    next.priceMinKurus = undefined;
    next.priceMaxKurus = undefined;
  }
  if (incoming.priceMinKurus != null || incoming.priceMaxKurus != null) {
    next.priceMinKurus = incoming.priceMinKurus ?? undefined;
    next.priceMaxKurus = incoming.priceMaxKurus ?? undefined;
  }
  if (incoming.colors && incoming.colors.length > 0) next.colors = incoming.colors;
  if (incoming.styles && incoming.styles.length > 0) next.styles = incoming.styles;
  if (incoming.sort) next.sort = incoming.sort;
  return sanitizeLinkPreferences(next);
}

function tl(kurus: number): string {
  return `${Math.round(kurus / 100).toLocaleString("tr-TR")} TL`;
}

/** Kullanıcıya gösterilen kısa tercih özeti (ALL CAPS ve yasaklı sözcük yok). */
export function describeLinkPreferences(preferences: LinkPreferences): string[] {
  const parts: string[] = [];
  if (preferences.colors?.length) parts.push(preferences.colors.join(", "));
  if (preferences.styles?.length) parts.push(preferences.styles.join(", "));
  const min = preferences.priceMinKurus ?? null;
  const max = preferences.priceMaxKurus ?? null;
  if (min !== null && max !== null) parts.push(`${tl(min)} – ${tl(max)} arası`);
  else if (max !== null) parts.push(`${tl(max)} altı`);
  else if (min !== null) parts.push(`${tl(min)} üstü`);
  if (preferences.sort === "cheapest") parts.push("uygun fiyattan başlayarak");
  return parts;
}

// ---------------------------------------------------------------------------
// Model çıktısı -> LinkPreferences (karar 0079, Faz 5)
// ---------------------------------------------------------------------------

function canonicalOf(
  value: string,
  lexicon: readonly LexiconEntry[],
  kinds: readonly LexiconEntry["kind"][],
): string | null {
  const folded = foldTurkish(value).trim();
  if (!folded) return null;
  for (const entry of lexicon) {
    if (!kinds.includes(entry.kind)) continue;
    if (foldTurkish(entry.surface).trim() === folded || foldTurkish(entry.normalized) === folded) {
      return entry.normalized;
    }
  }
  return null;
}

/**
 * Model yamasından YALNIZCA doğrulanabilir tercih alanlarını alır: renk (lexicon
 * `color`), fiyat (TL -> kuruş), `sort=cheapest`, stil/malzeme değerleri (lexicon
 * `style`/`material`). `query`, `category`, `brand`, `size`, `excludeBrands`,
 * öznitelik anahtarları ve geri kalan her şey ATILIR.
 */
export function linkPreferencesFromPatch(
  patch: SearchIntentPatch,
  lexicon: readonly LexiconEntry[],
): LinkPreferences {
  const out: LinkPreferences = {};
  const colors: string[] = [];
  for (const value of patch.colors ?? []) {
    const canonical = canonicalOf(value, lexicon, ["color"]);
    if (canonical && !colors.includes(canonical)) colors.push(canonical);
  }
  if (colors.length > 0) out.colors = colors;
  const styles: string[] = [];
  for (const value of Object.values(patch.attributes ?? {})) {
    const canonical = canonicalOf(value, lexicon, ["style", "material"]);
    if (canonical && !styles.includes(canonical)) styles.push(canonical);
  }
  if (styles.length > 0) out.styles = styles;
  if (patch.priceMin !== undefined && patch.priceMin > 0) out.priceMinKurus = patch.priceMin * 100;
  if (patch.priceMax !== undefined && patch.priceMax > 0) out.priceMaxKurus = patch.priceMax * 100;
  if (patch.sort === "cheapest") out.sort = "cheapest";
  return sanitizeLinkPreferences(out);
}
