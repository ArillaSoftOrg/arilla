/**
 * Takma ad / es anlam kaynaklari. Pipeline tek bir `AliasSource` arayuzune
 * bagimlidir; kaynak sayisi ve icerigi disaridan gelir.
 *
 * Bugun: (1) cok kucuk bir tohum, (2) DB `lexicon` tablosundaki `synonym`
 * satirlari. Ileride ayni arayuzle: taksonomi takma adlari, marka takma
 * adlari, ogrenilmis sorgu takma adlari. Yuzlerce sabit kelime BURAYA
 * yazilmaz; yeni bir esanlamli eklemek icin `lexicon`a satir eklenir.
 */
import type { LexiconEntry } from "../lexicon.ts";
import { foldForMatch } from "../text-match.ts";

export interface AliasSource {
  /** Katlanmis (ASCII, kucuk harf) token icin katlanmis alternatifler. */
  expand(token: string): readonly string[];
}

/**
 * Tohum: Turkce klavyede/konusmada en sik gorulen, tokenizasyonla
 * cozulemeyecek birkac cift. Genisletme yolu `lexicon`dir, bu liste degil.
 */
const SEED_ALIASES: readonly (readonly string[])[] = [
  ["kulaklik", "headphone", "headphones"],
  ["airpod", "airpods"],
  ["supurge", "vacuum"],
];

export function createSeedAliasSource(
  groups: readonly (readonly string[])[] = SEED_ALIASES,
): AliasSource {
  return createGroupAliasSource(groups);
}

/** Her grup karsilikli es anlamlidir. */
export function createGroupAliasSource(groups: readonly (readonly string[])[]): AliasSource {
  const index = new Map<string, Set<string>>();
  for (const group of groups) {
    const folded = group.map((word) => foldForMatch(word).trim()).filter(Boolean);
    for (const word of folded) {
      const set = index.get(word) ?? new Set<string>();
      for (const other of folded) if (other !== word) set.add(other);
      index.set(word, set);
    }
  }
  return {
    expand: (token) => [...(index.get(token) ?? [])],
  };
}

/** `lexicon.kind = 'synonym'` satirlari: ayni `normalized`i paylasanlar es anlamlidir. */
export function createLexiconAliasSource(entries: readonly LexiconEntry[]): AliasSource {
  const byGroup = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind !== "synonym") continue;
    const surface = foldForMatch(entry.surface).trim();
    if (!surface) continue;
    const group = byGroup.get(entry.normalized) ?? [];
    group.push(surface);
    byGroup.set(entry.normalized, group);
  }
  return createGroupAliasSource([...byGroup.values()]);
}

export function composeAliasSources(...sources: readonly AliasSource[]): AliasSource {
  return {
    expand(token) {
      const out = new Set<string>();
      for (const source of sources) for (const alt of source.expand(token)) out.add(alt);
      out.delete(token);
      return [...out];
    },
  };
}

export const NO_ALIASES: AliasSource = { expand: () => [] };
