import { resolveWithFallback } from "@arilla/core";
import type { DiscoveryItem } from "@arilla/ui";
import { DEMO_DISCOVERY_ITEMS } from "../data/demo/homepage-discovery.ts";

/**
 * Homepage kesif izgarasinin tek data-adaptor katmani (gorev talimati:
 * "iki ayri UI implementasyonu olusturma"). Aynı `DiscoveryCard`/masonry
 * `page.tsx`'te tek bir kaynaktan besleniyor:
 *
 * - Gercek `discovery_slot` satirlari varsa (`toDiscoveryItems`) onlar
 *   kullanilir - bunlarin gercek `/urun/<slug>` linki vardir.
 * - Yoksa VE `HOMEPAGE_DEMO_CONTENT=true` ise (Admitad oncesi demo vitrin,
 *   bkz. .env.example) Faz 3 demo veri setine dusulur.
 * - Ikisi de bossa/demo kapaliysa bos dizi doner, sayfa "bos durum: yok,
 *   sessizce atlanir" davranisini korur (docs/pages.md).
 *
 * Faz 3.1: demo gorunurlugu NODE_ENV'e degil, explicit
 * `HOMEPAGE_DEMO_CONTENT` degiskenine bagli - proje Admitad/merchant feed
 * gelmeden ONCE production'a vitrin amacli deploy edilecek, bu yuzden
 * "development'ta demo goster" mantigi yeterli degil. Oncelik kurali
 * (`resolveWithFallback`, @arilla/core) test edilebilir, veri-agnostik bir
 * fonksiyon - unit testleri packages/core/src/discovery-feed/
 * resolve-with-fallback.test.ts'te.
 */

interface DiscoveryFeedRow {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
}

function toDiscoveryItems(rows: readonly DiscoveryFeedRow[]): DiscoveryItem[] {
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
