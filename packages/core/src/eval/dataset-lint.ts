/**
 * Veri seti sagligi (Faz 1A): tekrar ve asiri benzerlik tespiti.
 * Test setini ayni seyi tekrar ederek buyutmeyi engeller.
 */

/** Turkce kucuk harf + noktalama atma + tokenlama. */
export function tokens(text: string): string[] {
  return text
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface NearDuplicate {
  a: string;
  b: string;
  similarity: number;
}

/** Esik ve uzeri benzerlikteki cift listesi (ayni metin dahil). */
export function findNearDuplicates(texts: readonly string[], threshold = 0.9): NearDuplicate[] {
  const out: NearDuplicate[] = [];
  const toks = texts.map(tokens);
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const similarity = jaccard(toks[i] as string[], toks[j] as string[]);
      if (similarity >= threshold) {
        out.push({ a: texts[i] as string, b: texts[j] as string, similarity });
      }
    }
  }
  return out;
}
