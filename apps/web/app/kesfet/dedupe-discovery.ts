import type { DiscoveryItem } from "@arilla/ui";

/**
 * /kesfet için tekrar ayırma (yalnızca sunum): aynı ürün (`id`) hem seçilmiş hem
 * kullanıcı keşfinde ya da iki konumda gelebilir (`discovery_slot` PK'si
 * (slot_date, position)). İlk görülen kalır; seçilmiş liste önceliklidir.
 * Veri kaynağına ve adaptöre dokunmaz.
 */
export function dedupeDiscoveryItems(
  curated: readonly DiscoveryItem[],
  organic: readonly DiscoveryItem[],
): { curated: DiscoveryItem[]; organic: DiscoveryItem[] } {
  const seen = new Set<string>();
  const keep = (items: readonly DiscoveryItem[]): DiscoveryItem[] =>
    items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  const nextCurated = keep(curated);
  return { curated: nextCurated, organic: keep(organic) };
}
