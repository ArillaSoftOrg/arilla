import { ResultsSkeleton } from "../search-results.tsx";

/**
 * /ara/link icin, /ara segmentinden devralinan davranisin aynisi. /ara metin
 * aramasi artik sayfa duzeyinde `loading.tsx` kullanmiyor (sonuc bolgesi kendi
 * `<Suspense>` sinirinda); bu rota etkilenmesin diye burada acikca tanimli.
 */
export default function LinkAramaLoading() {
  return <ResultsSkeleton statusLabel="Sonuçlar yükleniyor" />;
}
