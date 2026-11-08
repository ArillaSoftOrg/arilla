/**
 * Metin ve anlamsal adaylarin birlesimi (saf fonksiyon, veritabani/model yok).
 *
 * - Metin sonuclari HEP korunur: anlamsal arama metin sonucunu dusuremez.
 * - Anlamsal-yalniz aday ancak esikleri gecerse girer (mutlak benzerlik, en iyiye
 *   gore fark, sayi tavani). Aksesuar/ilgisiz urun yalnizca vektor benzerligi
 *   yuksek diye girmez: baslik korumasi SQL'de aday asamasinda uygulanir.
 * - Sira: Reciprocal Rank Fusion. Metin listesi saglayicinin (guven/fiyat/stok)
 *   siralamasidir; anlamsal liste benzerlik siralamasidir.
 */
import { DEFAULT_SEMANTIC_GATE, RRF_K, type SemanticGate } from "./config.ts";

export interface FusionItem {
  productId: number;
}

export interface SemanticItem extends FusionItem {
  similarity: number;
}

export interface FusedEntry<T extends FusionItem> {
  item: T;
  /** Hangi listelerde bulundu. */
  source: "text" | "semantic" | "both";
  score: number;
  similarity: number | null;
}

export interface FusionOptions<T extends FusionItem = FusionItem> {
  gate?: SemanticGate;
  /** Metin listesinin agirligi (varsayilan 1). */
  textWeight?: number;
  /** Anlamsal listenin agirligi (varsayilan 1). */
  semanticWeight?: number;
  rrfK?: number;
  /**
   * Metin adaylarinin sorguya kosinus benzerligi (yalniz vektoru OLAN urunler). Anlamsal kapidan
   * gecen aday varsa, benzerligi `gate.minSimilarity` altinda kalan metin-yalniz urunun metin
   * puani `unconfirmedTextFactor` ile carpilir (bulanik/alakasiz metin eslesmesi gercek anlamsal
   * eslesmenin onune gecmesin). Vektoru olmayan urun cezalandirilmaz.
   */
  textSimilarity?: ReadonlyMap<number, number>;
  unconfirmedTextFactor?: number;
  /**
   * Sorgu aksesuar istemiyorsa: aksesuar gibi gorunen metin sonucunun puani `accessoryTextFactor`
   * ile carpilir (silinmez). Verilmezse uygulanmaz.
   */
  isAccessory?: (item: T) => boolean;
  /**
   * Sorgunun bas isim urun turune UYMAYAN metin sonucu: yalnizca `textSimilarity`si bilinen VE
   * `gate.minSimilarity` altinda (anlamsal olarak da benzemeyen) ise sonuctan CIKARILIR. Iki bagimsiz
   * isaret birlikte gerekir; vektoru olmayan urun asla cikarilmaz.
   */
  isTypeMismatch?: (item: T) => boolean;
  /** Tur uyumsuzlugunda cikarma esigi (varsayilan `gate.minSimilarity`); olcumle secilir. */
  typeMismatchBelow?: number;
  accessoryTextFactor?: number;
}

/** Esikleri gecen anlamsal adaylar (benzerlige gore azalan, deterministik). */
export function gateSemantic<T extends SemanticItem>(
  semantic: readonly T[],
  textIds: ReadonlySet<number>,
  gate: SemanticGate = DEFAULT_SEMANTIC_GATE,
): T[] {
  const sorted = [...semantic].sort(
    (a, b) => b.similarity - a.similarity || a.productId - b.productId,
  );
  const best = sorted[0]?.similarity;
  if (best === undefined || best < gate.minSimilarity) return [];
  const kept: T[] = [];
  let semanticOnly = 0;
  for (const candidate of sorted) {
    if (candidate.similarity < gate.minSimilarity) break;
    if (best - candidate.similarity > gate.maxGapFromBest) break;
    if (textIds.has(candidate.productId)) {
      kept.push(candidate);
      continue;
    }
    if (semanticOnly >= gate.maxSemanticOnly) continue;
    semanticOnly += 1;
    kept.push(candidate);
  }
  return kept;
}

export function fuseResults<T extends FusionItem>(
  textInput: readonly T[],
  semantic: readonly (T & SemanticItem)[],
  options: FusionOptions<T> = {},
): FusedEntry<T>[] {
  const k = options.rrfK ?? RRF_K;
  const wText = options.textWeight ?? 1;
  const wSem = options.semanticWeight ?? 1;
  const gate = options.gate ?? DEFAULT_SEMANTIC_GATE;
  const text = textInput.filter((item) => {
    const known = options.textSimilarity?.get(item.productId);
    return !(
      known !== undefined &&
      known < (options.typeMismatchBelow ?? gate.minSimilarity) &&
      options.isTypeMismatch?.(item)
    );
  });
  const textIds = new Set(text.map((item) => item.productId));
  const accepted = gateSemantic(semantic, textIds, options.gate);

  const entries = new Map<number, FusedEntry<T>>();
  const demote = accepted.length > 0 ? (options.unconfirmedTextFactor ?? 0.3) : 1;
  text.forEach((item, index) => {
    const known = options.textSimilarity?.get(item.productId);
    const unconfirmed = known !== undefined && known < gate.minSimilarity;
    entries.set(item.productId, {
      item,
      source: "text",
      score:
        (wText / (k + index + 1)) *
        (unconfirmed ? demote : 1) *
        (options.isAccessory?.(item) ? (options.accessoryTextFactor ?? 0.3) : 1),
      similarity: known ?? null,
    });
  });
  accepted.forEach((candidate, index) => {
    const add = wSem / (k + index + 1);
    const existing = entries.get(candidate.productId);
    if (existing) {
      existing.source = "both";
      existing.score += add;
      existing.similarity = candidate.similarity;
    } else {
      entries.set(candidate.productId, {
        item: candidate,
        source: "semantic",
        score: add,
        similarity: candidate.similarity,
      });
    }
  });
  return [...entries.values()].sort(
    (a, b) => b.score - a.score || a.item.productId - b.item.productId,
  );
}
