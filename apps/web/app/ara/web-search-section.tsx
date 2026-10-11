import {
  attachCatalogImages,
  attachStoreImages,
  type CatalogImageCandidate,
  dropCatalogDuplicates,
  selectImagedGroups,
} from "@arilla/core";
import { ErrorView } from "../error-view.tsx";
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
    // Katalog sonuclari ayri bolumdedir ve yerinde kalir; yalnizca bu bolum hata gosterir.
    return <ErrorView error={{ code: "web_search_unavailable" }} />;
  }
  if (outcome.status !== "ok") return null;

  // Once katalog gorseli (kendi feed'imiz), kalanlar icin magaza sayfasindan dogrulanmis gorsel.
  // Gorseli dogrulanamayan urun GOSTERILMEZ; hic biri kalmazsa bolum cizilmez, katalog sonuclari durur.
  const groups = selectImagedGroups(
    await attachStoreImages(
      attachCatalogImages(
        dropCatalogDuplicates(outcome.groups, {
          hosts: catalogHosts,
          titles: catalog.map((item) => item.title),
        }),
        catalog,
      ),
    ),
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
