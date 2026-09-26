import { findDemoProduct } from "../data/demo/products.ts";

function toSearchChip(productId: string, label: string, meta: string) {
  const product = findDemoProduct(productId);
  return {
    label,
    meta,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
  };
}

/**
 * Ana sayfa "Alışverişe devam et" ornek sorgulari - kisisel gecmis degil,
 * sabit ornekler. UI-metni degil, ornek sorgu verisi - docs/copy.md'ye eklenmez.
 */
export const HOME_SEARCH_CHIPS: readonly {
  label: string;
  meta: string;
  imageUrl: string;
  imageAlt: string;
}[] = [
  toSearchChip("nike-air-force-1-07", "Beyaz sneaker", "Popüler arama"),
  toSearchChip("herschel-classic-hip-pack", "Bel çantası", "Trend fikir"),
  toSearchChip("ikea-markus-chair", "Çalışma koltuğu", "Ev ofisi"),
  toSearchChip("ikea-forsa-lamp", "Masa lambası", "Ev ofisi"),
  toSearchChip("nike-club-hoodie", "Oversize hoodie", "Giyim fikri"),
];
