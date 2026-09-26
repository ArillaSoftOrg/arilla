/**
 * Link araması sıralaması (docs/decisions/0031) — saf fonksiyonlar, veritabanı yok.
 *
 * İki ayrı kavram:
 *
 * - AYNI ÜRÜN: yalnızca kimlik kanıtıyla — barkod (GTIN) eşitliği ya da aynı
 *   marka altında üretici kodu (MPN) eşitliği. Görsel benzerlik ne kadar
 *   yüksek olursa olsun "aynı ürün" DEMEK DEĞİLDİR: aynı fotoğrafı paylaşan
 *   renk varyantları, aynı stok görseli kullanan farklı satıcılar var (0029).
 * - BENZER ÜRÜN: sinyallerin ağırlıklı toplamı. Görsel varsa ağırlığın çoğu
 *   görselde; metin ve marka eşleşmesi sıralamayı düzeltir.
 */

export type IdentityEvidence = "gtin" | "mpn";

export interface LinkCandidate {
  productId: number;
  /** Kosinüs benzerliği, 0-1. Görsel sinyal yoksa ya da aday görselden gelmediyse yok. */
  visual?: number;
  /** pg_trgm başlık benzerliği, 0-1. */
  text?: number;
  brandMatch: boolean;
  identity?: IdentityEvidence;
}

export interface RankedCandidate extends LinkCandidate {
  score: number;
}

export interface RankedLinkCandidates {
  same: RankedCandidate[];
  similar: RankedCandidate[];
}

/** Görsel varken: görsel belirleyici, metin ve marka düzeltir. */
export const WEIGHTS_WITH_IMAGE = { visual: 0.65, text: 0.25, brand: 0.1 } as const;
/** Görsel yokken yalnızca metin ve marka. */
export const WEIGHTS_TEXT_ONLY = { visual: 0, text: 0.8, brand: 0.2 } as const;

/** Adayları ürün kimliğine göre birleştirir; aynı ürünün en güçlü sinyalleri kalır. */
export function mergeCandidates(lists: readonly (readonly LinkCandidate[])[]): LinkCandidate[] {
  const byId = new Map<number, LinkCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const current = byId.get(candidate.productId);
      if (!current) {
        byId.set(candidate.productId, { ...candidate });
        continue;
      }
      current.visual = maxDefined(current.visual, candidate.visual);
      current.text = maxDefined(current.text, candidate.text);
      current.brandMatch = current.brandMatch || candidate.brandMatch;
      current.identity = strongerIdentity(current.identity, candidate.identity);
    }
  }
  return [...byId.values()];
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function strongerIdentity(
  a: IdentityEvidence | undefined,
  b: IdentityEvidence | undefined,
): IdentityEvidence | undefined {
  if (a === "gtin" || b === "gtin") return "gtin";
  return a ?? b;
}

export function scoreCandidate(candidate: LinkCandidate, hasImage: boolean): number {
  const weights = hasImage ? WEIGHTS_WITH_IMAGE : WEIGHTS_TEXT_ONLY;
  const score =
    weights.visual * (candidate.visual ?? 0) +
    weights.text * (candidate.text ?? 0) +
    weights.brand * (candidate.brandMatch ? 1 : 0);
  return Math.round(score * 10_000) / 10_000;
}

/**
 * Adayları "aynı ürün" ve "benzer ürün" olarak ayırır ve sıralar.
 * `excludeProductIds`: kaynağın kendisi (katalogdaki karşılığı) listede görünmez.
 */
export function rankLinkCandidates(
  lists: readonly (readonly LinkCandidate[])[],
  options: { hasImage: boolean; limit: number; excludeProductIds?: readonly number[] },
): RankedLinkCandidates {
  const excluded = new Set(options.excludeProductIds ?? []);
  const ranked = mergeCandidates(lists)
    .filter((candidate) => !excluded.has(candidate.productId))
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, options.hasImage) }))
    .sort((a, b) => b.score - a.score || a.productId - b.productId);

  const same = ranked.filter((candidate) => candidate.identity !== undefined);
  const similar = ranked
    .filter((candidate) => candidate.identity === undefined)
    .slice(0, options.limit);
  return { same, similar };
}

/** Barkod karşılaştırması için: yalnızca rakamlar, baştaki sıfırlar GTIN-14'e kadar eşitlenir. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) return null;
  return digits.padStart(14, "0");
}
