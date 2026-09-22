import type { TrustPoint } from "@arilla/ui";
import { HOME_COPY } from "./home-copy.ts";

/**
 * docs/pages.md "/" Faz 5: sosyal kanit DEGIL - dogrulanmamis sayi/istatistik
 * yok, yalnizca gercek/zamansiz kabiliyetler (gorev talimati).
 */
export const HOME_TRUST_POINTS: readonly TrustPoint[] = [
  { id: "alternatives", text: HOME_COPY.trustPointAlternatives },
  { id: "compare", text: HOME_COPY.trustPointCompare },
  { id: "freshness", text: HOME_COPY.trustPointFreshness },
];
