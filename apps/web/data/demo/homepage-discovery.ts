import type { DiscoveryItem } from "@arilla/ui";
import { DEMO_PRODUCTS } from "./products.ts";

/**
 * GECICI demo veri seti - ana sayfanin kesif izgarasini (`id="kesfet"`)
 * doldurur, YALNIZCA `discovery_slot` tablosu bos oldugunda ve
 * `HOMEPAGE_DEMO_CONTENT=true` iken kullanilir (bkz. .env.example,
 * apps/web/app/discovery-adapter.ts). NODE_ENV'e bagli degildir - proje
 * Admitad oncesi production'a vitrin amacli deploy edilebilir. Gercek veri
 * her zaman bu demo setin onunde gelir.
 *
 * Urunler ./products.ts'teki TEK ortak katalogdan gelir - ayni urun
 * metadata'si burada tekrar yazilmaz. Bu demo urunler gercek katalogda
 * olmadigi icin `href` verilmez (dead link/sahte urun sayfasi olusturulmaz -
 * bkz. DiscoveryCard).
 */
export const DEMO_DISCOVERY_ITEMS: readonly DiscoveryItem[] = DEMO_PRODUCTS.map((product) => ({
  id: product.id,
  title: product.title,
  brand: product.brand,
  imageUrl: product.imageUrl,
  imageAlt: product.imageAlt,
  aspectRatio: product.aspectRatio,
}));
