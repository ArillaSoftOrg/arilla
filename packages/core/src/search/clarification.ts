/**
 * Netlestirme kurali (docs/search.md, "Netlestirme"): "sorgu birden fazla
 * kategori yoluna anlamli hacimle dusuyorsa netlestirme sunulur. Tek
 * kategoriye dusuyorsa sunulmaz."
 *
 * Saf fonksiyon: gercek kategori agacini sorgulamaz. C1'in
 * `query-resolution.ts`'i tekil/bos aday listesiyle cagirir; gercek
 * coklu-aday hacim hesaplama (orn. kategori agacindan urun sayisi) C2'nin
 * isidir - bu fonksiyonun imzasi o zaman degismeden kalir.
 *
 * `dominanceThreshold` ve `minCandidateShare` icin docs/search.md kesin bir
 * sayi vermiyor; asagidaki varsayilanlar ayarlanabilir placeholder'dir.
 */

export interface CategoryCandidate {
  categoryId: number;
  categoryPath: string;
  matchCount: number;
}

export interface ClarificationOptions {
  /** En buyuk adayin toplam hacimdeki payi bunun ustundeyse tek kategoriye dustu sayilir. */
  dominanceThreshold?: number;
  /** Toplam hacmin bu oranindan azini alan adaylar gurultu sayilip elenir. */
  minCandidateShare?: number;
}

export interface ClarificationResult {
  needsClarification: boolean;
  candidateCategoryIds: number[];
}

const DEFAULT_DOMINANCE_THRESHOLD = 0.6;
const DEFAULT_MIN_CANDIDATE_SHARE = 0.15;

export function decideClarification(
  candidates: readonly CategoryCandidate[],
  options: ClarificationOptions = {},
): ClarificationResult {
  const dominanceThreshold = options.dominanceThreshold ?? DEFAULT_DOMINANCE_THRESHOLD;
  const minCandidateShare = options.minCandidateShare ?? DEFAULT_MIN_CANDIDATE_SHARE;

  const total = candidates.reduce((sum, candidate) => sum + candidate.matchCount, 0);
  if (total <= 0 || candidates.length === 0) {
    return { needsClarification: false, candidateCategoryIds: [] };
  }

  const significant = candidates.filter(
    (candidate) => candidate.matchCount / total >= minCandidateShare,
  );
  if (significant.length <= 1) {
    return {
      needsClarification: false,
      candidateCategoryIds: significant.map((candidate) => candidate.categoryId),
    };
  }

  const sorted = [...significant].sort((a, b) => b.matchCount - a.matchCount);
  const top = sorted[0];
  if (top !== undefined && top.matchCount / total >= dominanceThreshold) {
    return { needsClarification: false, candidateCategoryIds: [top.categoryId] };
  }

  return {
    needsClarification: true,
    candidateCategoryIds: sorted.map((candidate) => candidate.categoryId),
  };
}
