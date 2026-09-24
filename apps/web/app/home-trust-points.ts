import type { TrustPoint } from "@arilla/ui";
import { HOME_COPY } from "./home-copy.ts";

/**
 * docs/pages.md "/" Seffaflik: sosyal kanit DEGIL - dogrulanmamis sayi/
 * istatistik, "en buyuk" iddiasi, musteri yorumu yok. Yalnizca gercek
 * kabiliyetler ve sinirlar: ayni/benzer bulma, magaza karsilastirma, fiyat-
 * stok bilgisinin kaynagi ve zamani, komisyon bildirimi (CLAUDE.md:
 * komisyon siralamada yalnizca esit kosullarda ayristiricidir).
 */
export const HOME_TRUST_POINTS: readonly TrustPoint[] = [
  {
    id: "alternatives",
    title: HOME_COPY.trustPointAlternativesTitle,
    text: HOME_COPY.trustPointAlternatives,
  },
  { id: "compare", title: HOME_COPY.trustPointCompareTitle, text: HOME_COPY.trustPointCompare },
  {
    id: "freshness",
    title: HOME_COPY.trustPointFreshnessTitle,
    text: HOME_COPY.trustPointFreshness,
  },
  {
    id: "commission",
    title: HOME_COPY.trustPointCommissionTitle,
    text: HOME_COPY.trustPointCommission,
  },
];
