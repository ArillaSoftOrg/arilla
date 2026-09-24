import { ResultsSkeleton } from "../search-results.tsx";

/** docs/pages.md: "Görsel aramada iskelet kartlar sonuç gelene kadar durur." */
export default function GorselAramaLoading() {
  return <ResultsSkeleton statusLabel="Benzerlerini arıyoruz" showTabs={false} />;
}
