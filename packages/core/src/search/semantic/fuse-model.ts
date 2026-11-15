/**
 * Sunumun birlestirme adaptoru (karar 0196): aktif indeksin `fusion` turune gore metin sonuclari ve
 * anlamsal adaylar birlesir. Saf fonksiyon (veritabani/model yok).
 *
 * - `rrf_gate` (Jina): mevcut `fuseForQuery` (mutlak kosinus kapisi + RRF); davranis DEGISMEZ.
 * - `conditional_hybrid` (BGE-M3): `hybrid-policy.ts` (E4; 49 sorguluk gelistirme kumesinde secildi,
 *   AI destekli on degerlendirme). BGE'de alakasiz urunler de 0,45-0,61 kosinus alir; mutlak esik
 *   calismaz. Lexical sonuclarin ilk blogu korunur, anlamsal eklemeler sorgu-ici goreli esikle ve aday
 *   temizligiyle (teknik kod, olumsuzluk, karsit ozellik, aksesuar, gurultu) girer.
 *
 * Ortak sozlesme: metin sonucu HIC dusmez; yalniz-anlamsal urun sayisi cagiran tarafta
 * `SEMANTIC_SERVING_MAX_ADDED` ile sinirlanir; kesin kategori/fiyat suzgeci SQL'de (aday) ve kart
 * yuklemede (hydrate) uygulanir, burada gevsetilmez.
 */

import type { RankedSearchItem } from "../fallback/types.ts";
import type { LexiconEntry } from "../lexicon.ts";
import type { FusionKind } from "./active-index.ts";
import {
  buildCandidateCheck,
  conditionalHybrid,
  type PolicyCandidate,
  type PolicyTextItem,
} from "./hybrid-policy.ts";
import type { SemanticCandidate } from "./semantic-candidates.ts";
import { fuseForQuery } from "./shadow.ts";

export interface FusedProduct {
  productId: number;
  source: "text" | "semantic" | "both";
  similarity: number | null;
}

export interface FusionOutput {
  entries: FusedProduct[];
  /** Politika modu (yalniz `conditional_hybrid`); izleme icin. */
  mode: string | null;
}

export function fuseForIndex(
  kind: FusionKind | undefined,
  items: readonly RankedSearchItem[],
  candidates: readonly SemanticCandidate[],
  queryText: string,
  textSimilarity: ReadonlyMap<number, number>,
  lexicon: readonly LexiconEntry[],
): FusionOutput {
  if (kind === "conditional_hybrid") {
    const text: PolicyTextItem[] = items.map((item) => ({
      productId: item.productId,
      title: item.title,
      tier: item.match.tier,
      similarity: textSimilarity.get(item.productId) ?? null,
    }));
    const pool: PolicyCandidate[] = candidates.map((c) => ({
      productId: c.productId,
      title: c.title,
      similarity: c.similarity,
    }));
    const result = conditionalHybrid(text, pool, buildCandidateCheck(queryText, lexicon));
    return {
      mode: result.mode,
      entries: result.ranked.map((e) => ({
        productId: e.productId,
        source: e.source,
        similarity: e.similarity,
      })),
    };
  }
  const { fused } = fuseForQuery(items, candidates, queryText, textSimilarity);
  return {
    mode: null,
    entries: fused.map((e) => ({
      productId: e.item.productId,
      source: e.source,
      similarity: e.similarity,
    })),
  };
}
