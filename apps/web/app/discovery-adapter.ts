import { resolveWithFallback } from "@arilla/core";
import { type DiscoveryItem, formatTRY } from "@arilla/ui";
import { DEMO_DISCOVERY_ITEMS } from "../data/demo/homepage-discovery.ts";
import { HOME_COPY } from "./home-copy.ts";

/**
 * Kesif izgarasinin tek sunum adaptoru - ana sayfa `#kesfet` ve `/kesfet`
 * ayni `DiscoveryGrid`/`DiscoveryCard`'i buradan besler (iki ayri UI yok).
 * Yalnizca sunum eslemesi yapar; is kurali tasimaz (CLAUDE.md kural 6).
 *
 * Ana sayfa oncelik sirasi (degismez):
 * - Gercek `discovery_slot` satirlari varsa (`toDiscoveryItems`) onlar
 *   kullanilir - bunlarin gercek `/urun/<slug>` linki vardir.
 * - Yoksa VE `HOMEPAGE_DEMO_CONTENT=true` ise (Admitad oncesi demo vitrin,
 *   bkz. .env.example) demo veri setine dusulur - demo kartlarin linki ve
 *   fiyati YOK.
 * - Ikisi de bossa/demo kapaliysa bos dizi doner, sayfa bolumu sessizce
 *   atlar (docs/pages.md).
 *
 * Oncelik kurali (`resolveWithFallback`, @arilla/core) test edilebilir,
 * veri-agnostik bir fonksiyon - unit testleri packages/core/src/
 * discovery-feed/resolve-with-fallback.test.ts'te.
 */

interface DiscoveryFeedRow {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  /** Kurus cinsinden tamsayi; yoksa fiyat gosterilmez. */
  minPrice?: number | null;
  offerCount?: number | null;
}

export function toDiscoveryItems(rows: readonly DiscoveryFeedRow[]): DiscoveryItem[] {
  return rows
    .filter(
      (row): row is DiscoveryFeedRow & { primaryImageUrl: string } => row.primaryImageUrl !== null,
    )
    .map((row) => ({
      id: `product-${row.productId}`,
      title: row.title,
      imageUrl: row.primaryImageUrl,
      imageAlt: row.title,
      href: `/urun/${row.slug}`,
      priceLabel:
        row.minPrice !== null && row.minPrice !== undefined ? formatTRY(row.minPrice) : undefined,
      metaLabel:
        row.offerCount !== null && row.offerCount !== undefined && row.offerCount > 0
          ? `${row.offerCount} ${HOME_COPY.offerCountLabel}`
          : undefined,
    }));
}

/**
 * Deterministik parse: yalnizca tam olarak "true" degeri acar. "false",
 * tanimsiz, bos string veya baska herhangi bir deger kapali sayilir -
 * `Boolean(process.env.X)` gibi yanlis-truthy kontrolu YAPILMAZ ("false"
 * string'i de truthy olurdu).
 */
function isHomepageDemoContentEnabled(): boolean {
  return process.env.HOMEPAGE_DEMO_CONTENT === "true";
}

export function resolveDiscoveryItems(rows: readonly DiscoveryFeedRow[]): readonly DiscoveryItem[] {
  const realItems = toDiscoveryItems(rows);
  return resolveWithFallback(realItems, DEMO_DISCOVERY_ITEMS, isHomepageDemoContentEnabled());
}
