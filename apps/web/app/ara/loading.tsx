import { ResultsSkeleton } from "./search-results.tsx";

/**
 * Next.js'in yerlesik Suspense mekanizmasi: sayfa verisi hazir olana kadar
 * otomatik gosterilir. docs/pages.md: "Yükleniyor: iskelet kart, spinner
 * değil."
 */
export default function AramaLoading() {
  return <ResultsSkeleton statusLabel="Sonuçlar yükleniyor" />;
}
