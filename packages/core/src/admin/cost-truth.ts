/**
 * Model maliyetinin dürüst gösterimi (docs/decisions/0051).
 *
 * `api_usage.cost_micros`, çağrı anındaki maliyet oranıyla
 * (`EMBEDDING_COST_MICROS_PER_1K_TOKENS`) hesaplanır. Oran tanımlı değilse
 * satır 0 maliyetle yazılır: ekranda "0,00 TL" görünür ama gerçek harcama
 * sıfır değildir. Bu yüzden toplam maliyet tek başına gösterilmez; önbellekten
 * DÖNMEYEN ama maliyeti 0 olan çağrılar ("fiyatlanmamış") ayrıca sayılır.
 *
 * Önbellek isabeti gerçekten ücretsizdir; fiyatlanmamış sayılmaz.
 */

export interface CostSummary {
  /** `sum(cost_micros)`: yalnızca fiyatlanmış çağrıların toplamı. */
  costMicros: number;
  calls: number;
  cacheHits: number;
  /** `sum(units)`: sağlayıcının saydığı birim (embedding'de token). */
  units: number;
  /** Önbellekten dönmeyen ama `cost_micros = 0` yazılan çağrılar. */
  unpricedCalls: number;
}

export type CostState =
  /** Çağrı yok ya da tüm ücretli çağrılar fiyatlanmış: toplam gerçektir. */
  | "priced"
  /** Ücretli çağrıların hiçbiri fiyatlanmamış: toplam bilinmiyor. */
  | "unpriced"
  /** Bir kısmı fiyatlanmamış: toplam en az bu kadardır. */
  | "partial";

export function costState(summary: Pick<CostSummary, "costMicros" | "unpricedCalls">): CostState {
  if (summary.unpricedCalls <= 0) return "priced";
  return summary.costMicros > 0 ? "partial" : "unpriced";
}

export function emptyCostSummary(): CostSummary {
  return { costMicros: 0, calls: 0, cacheHits: 0, units: 0, unpricedCalls: 0 };
}

export function addCost(into: CostSummary, row: CostSummary): CostSummary {
  return {
    costMicros: into.costMicros + row.costMicros,
    calls: into.calls + row.calls,
    cacheHits: into.cacheHits + row.cacheHits,
    units: into.units + row.units,
    unpricedCalls: into.unpricedCalls + row.unpricedCalls,
  };
}
