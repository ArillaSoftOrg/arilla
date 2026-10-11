import {
  attachCatalogImages,
  type CatalogImageCandidate,
  dropCatalogDuplicates,
} from "@arilla/core";
import styles from "./ara.module.css";
import { WEB_SEARCH_COPY as COPY } from "./web-search-copy.ts";
import type { WebSearchBundle } from "./web-search-start.ts";
import { WebResultsView } from "./web-search-view.tsx";

export { WebSearchPending } from "./web-search-view.tsx";

/**
 * Internet sonuclari (karar 0102), sunucu tarafi. Katalog sonuclari bu bolumden
 * BAGIMSIZ ve once gorunur; bu bilesen yalnizca internet aramasi bittiginde
 * akar. Basarisizlikta katalog sonuclarina dokunulmaz; kapali/uygunsuz/limitli
 * durumlarda hicbir sey cizilmez. Sonuclar saklanmaz.
 */
export async function WebSearchResults({
  promise,
  catalog,
  variant = "ara",
  idPrefix,
}: {
  promise: Promise<WebSearchBundle>;
  variant?: "ara" | "chat";
  idPrefix?: string;
  /** Veritabani sonuclari: yinelenen teklifi atmak ve ayni urunun katalog gorselini bulmak icin. */
  catalog: readonly CatalogImageCandidate[];
}) {
  const { outcome, catalogHosts } = await promise;
  if (outcome.status === "error" || outcome.status === "unavailable") {
    return (
      <p className={styles.webNote} role="status">
        {COPY.failed}
      </p>
    );
  }
  if (outcome.status !== "ok") return null;

  const groups = attachCatalogImages(
    dropCatalogDuplicates(outcome.groups, {
      hosts: catalogHosts,
      titles: catalog.map((item) => item.title),
    }),
    catalog,
  );
  return (
    <WebResultsView
      groups={groups}
      suggestionsHtml={outcome.searchSuggestionsHtml}
      variant={variant}
      idPrefix={idPrefix}
    />
  );
}
