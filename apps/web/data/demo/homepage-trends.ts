import type { TrendCollection } from "@arilla/ui";
import { findDemoProduct } from "./products.ts";

/**
 * GECICI demo veri seti - Admitad/feed entegrasyonu gelene kadar ana
 * sayfadaki "Trendler" bolumunu doldurur (docs/pages.md "/" satir 4).
 * Urunler ./products.ts'teki TEK ortak katalogdan referans alinir - ayni
 * urun metadata'si burada tekrar yazilmaz (gorev talimati).
 *
 * Fiyat, indirim, stok, populerlik gibi dogrulanmamis/sahte sinyaller
 * kasitli olarak YOK.
 */
function toTrendProduct(id: string) {
  const product = findDemoProduct(id);
  return {
    id: product.id,
    title: product.title,
    brand: product.brand,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
  };
}

export const DEMO_HOMEPAGE_TRENDS: readonly TrendCollection[] = [
  {
    id: "daily-sneaker-edit",
    eyebrow: "Ayakkabı",
    title: "Günlük sneaker seçkisi",
    description: "Beyaz tabandan retro spor ayakkabıya, her güne uyan rahat seçenekler.",
    heroImageUrl: findDemoProduct("nike-air-force-1-07").imageUrl,
    heroImageAlt: findDemoProduct("nike-air-force-1-07").imageAlt,
    products: [
      toTrendProduct("nike-air-force-1-07"),
      toTrendProduct("puma-suede-classic-xxi"),
      toTrendProduct("veja-campo-leather-white-black"),
    ],
  },
  {
    id: "home-workspace",
    eyebrow: "Ev ofisi",
    title: "Çalışma alanı",
    description:
      "Uzun oturma seansları için destekleyici bir koltuk, doğru ışık ve düzenli bir masa yüzeyi.",
    heroImageUrl: findDemoProduct("ikea-markus-chair").imageUrl,
    heroImageAlt: findDemoProduct("ikea-markus-chair").imageAlt,
    products: [
      toTrendProduct("ikea-markus-chair"),
      toTrendProduct("ikea-forsa-lamp"),
      toTrendProduct("ikea-ovning-organizer"),
    ],
  },
  {
    id: "autumn-everyday-style",
    eyebrow: "Giyim",
    title: "Sonbahar günlük stili",
    description: "Kalın kumaşlar ve rahat siluetlerle mevsime uygun katmanlı görünümler.",
    heroImageUrl: findDemoProduct("carhartt-wip-detroit-jacket").imageUrl,
    heroImageAlt: findDemoProduct("carhartt-wip-detroit-jacket").imageAlt,
    products: [
      toTrendProduct("carhartt-wip-detroit-jacket"),
      toTrendProduct("la-apparel-heavy-fleece-crewneck"),
      toTrendProduct("herschel-little-america-backpack"),
    ],
  },
];
