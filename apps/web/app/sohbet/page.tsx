import { type AramaSearchParams, SearchPage } from "../lib/search/search-page.tsx";

/**
 * Tek arama yuzeyi (karar 0176): `/sohbet?q=` "arama turu"dur - eski `/ara` akisinin
 * aynisi (0002 duvari, IntentV2, kademeli arama, siralama, sayfalama, internet aramasi).
 * Oturumlu takip konusmasi `/sohbet/[id]`'dedir; `/ara` adresleri buraya 308 ile yonlenir.
 */
export default function SohbetSearchPage({
  searchParams,
}: {
  searchParams: Promise<AramaSearchParams>;
}) {
  return SearchPage({ searchParams });
}
