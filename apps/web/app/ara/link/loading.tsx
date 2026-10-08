import { LINK_SEARCH_PUBLIC } from "@arilla/core/link-input";
import { ResultsSkeleton } from "../search-results.tsx";
import { LinkSearchComingSoon } from "./link-search-coming-soon.tsx";

/**
 * /ara/link icin, /ara segmentinden devralinan davranisin aynisi. /ara metin
 * aramasi artik sayfa duzeyinde `loading.tsx` kullanmiyor (sonuc bolgesi kendi
 * `<Suspense>` sinirinda); bu rota etkilenmesin diye burada acikca tanimli.
 */
export default function LinkAramaLoading() {
  // Kapalıyken sonuç iskeleti gösterilmez; sayfayla aynı "Yakında" durumu.
  if (!LINK_SEARCH_PUBLIC) return <LinkSearchComingSoon />;
  return <ResultsSkeleton statusLabel="Sonuçlar yükleniyor" />;
}
