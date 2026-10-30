import type { SavedPriceChange } from "@arilla/core";
import { formatTRY } from "@arilla/ui";

/** Yuzde yalniz tam sayiya yuvarlandiginda 0'dan buyukse yazilir ("%0" yazilmaz). */
function percentSuffix(percent: number): string {
  return percent > 0 ? ` (%${percent.toLocaleString("tr-TR")})` : "";
}

/** `/kaydettiklerim` metinleri (docs/copy.md `empty.saved*`, `saved.*`). */
export const SAVED_COPY = {
  title: "Kaydettiklerim", // nav.saved
  count: (count: number) => `${count.toLocaleString("tr-TR")} ürün`, // saved.count
  offerCount: (count: number) => `${count.toLocaleString("tr-TR")} mağaza`, // search.offer_count
  emptyTitle: "Henüz kaydettiğin ürün yok.", // empty.saved
  emptyDescription:
    "Beğendiğin bir ürünü kaydet; burada toplansın, fiyatlarını tek yerden takip et.", // empty.saved_description
  emptyAction: "Keşfet", // empty.saved_action
  remove: (title: string) => `Kaydettiklerimden kaldır: ${title}`, // saved.remove
  removeError: "Ürün kaldırılamadı. Tekrar dener misin?", // saved.remove_error
  // saved.price_change_* (karar 0159): ayni teklifin kayit anindaki ve bugunku fiyati.
  priceChange: (change: SavedPriceChange): string => {
    switch (change.kind) {
      case "down":
        return `Kaydettiğinden beri ${formatTRY(change.diffKurus)} düştü${percentSuffix(change.percent)}`;
      case "up":
        return `Kaydettiğinden beri ${formatTRY(change.diffKurus)} arttı${percentSuffix(change.percent)}`;
      case "same":
        return "Kaydettiğinden beri fiyatı değişmedi";
      case "insufficient":
        return "Karşılaştırma için yeterli veri yok";
    }
  },
} as const;
