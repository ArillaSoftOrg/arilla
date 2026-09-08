/**
 * Turkce metin normalizasyonu. `docs/search.md`: "Siyah, siyah, black hepsi
 * black olur" - normalize etmeden ayni deger uc farkli sekilde saklanir.
 *
 * `toLocaleLowerCase("tr-TR")` kullanilir: duz `toLowerCase()` "I" harfini
 * "ı" yerine "i" yapar, Turkce'de bu yanlistir (CLAUDE.md: ALL CAPS
 * donusumu i/ı ve I/İ yuzunden bozulur - ayni tuzak kucuk harfe cevirirken
 * de gecerlidir).
 */
export function foldTurkish(text: string): string {
  return text.toLocaleLowerCase("tr-TR");
}

/** `query_resolution.query_norm` icin onbellek anahtari. */
export function normalizeQueryText(text: string): string {
  return foldTurkish(text).trim().replace(/\s+/g, " ");
}

/**
 * `offer_variant.size_norm` ile karsilastirilabilir bicim. `packages/db`'nin
 * tohum betigindeki slugify kuralinin ayni mantigini yansitir (kucuk harf,
 * bosluklar tire olur) - paylasilan bir yardimci disari acilmadigi icin
 * burada kucuk olcekte tekrarlanir.
 */
export function normalizeSizeToken(token: string): string {
  return foldTurkish(token).trim().replace(/\s+/g, "-");
}

export interface Token {
  value: string;
  start: number;
  end: number;
}

/** Bosluga gore ayrilmis token'lar, orijinal metindeki karakter araligiyla. */
export function tokenizeWithOffsets(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index;
    tokens.push({ value: match[0], start, end: start + match[0].length });
  }
  return tokens;
}
