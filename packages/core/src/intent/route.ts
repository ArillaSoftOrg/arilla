/**
 * Gemini cagri yonlendirmesi (0171 §5). Cagri ORANI hedef degildir; gozlenen
 * bir ciktidir. Karar, yerel analizin yeterliligine gore verilir ve her
 * karar neden kodlariyla loglanabilir. Esikler Faz 1B'de dev setinde kova
 * bazli dogruluk kazanci, gecikme ve maliyetle kalibre edilir; holdout'a
 * dokunulmaz.
 */
import type { LocalAnalysis } from "./local-analysis.ts";

export type RouteReason =
  // cagri yok
  | "ineligible"
  | "cache_hit"
  | "empty_query"
  | "single_token"
  | "sufficient_local"
  // cagri var
  | "relation_marker"
  | "negation"
  | "accessory_with_device"
  | "no_product_type"
  | "low_coverage"
  | "long_query"
  | "unit_and_type";

export interface RouteThresholds {
  /** Bu oranin altindaki aciklanan token orani yerel analizi yetersiz sayar. */
  lowCoverage: number;
  /** Bu sayida ya da daha fazla token "uzun sorgu"dur. */
  longQuery: number;
}

/** Baslangic degerleri; Faz 1B kalibrasyonuna kadar gecici. */
export const DEFAULT_ROUTE_THRESHOLDS: RouteThresholds = { lowCoverage: 0.6, longQuery: 5 };

export interface RouteDecision {
  callModel: boolean;
  reasons: RouteReason[];
}

export function decideRoute(
  local: LocalAnalysis,
  context: { eligible: boolean; cacheHit: boolean },
  thresholds: RouteThresholds = DEFAULT_ROUTE_THRESHOLDS,
): RouteDecision {
  if (!context.eligible) return { callModel: false, reasons: ["ineligible"] };
  if (context.cacheHit) return { callModel: false, reasons: ["cache_hit"] };
  if (local.tokenCount === 0) return { callModel: false, reasons: ["empty_query"] };
  if (local.tokenCount === 1) return { callModel: false, reasons: ["single_token"] };

  const reasons: RouteReason[] = [];
  if (local.signals.has("relation_marker")) reasons.push("relation_marker");
  if (local.signals.has("negation")) reasons.push("negation");
  if (local.signals.has("accessory_with_device")) reasons.push("accessory_with_device");
  if (!local.signals.has("product_type_found") && !local.signals.has("brand_found")) {
    reasons.push("no_product_type");
  }
  if (local.coverage < thresholds.lowCoverage) reasons.push("low_coverage");
  if (local.tokenCount >= thresholds.longQuery) reasons.push("long_query");
  if (local.signals.has("unit_token") && local.signals.has("product_type_found")) {
    reasons.push("unit_and_type");
  }
  if (reasons.length === 0) return { callModel: false, reasons: ["sufficient_local"] };
  return { callModel: true, reasons };
}
