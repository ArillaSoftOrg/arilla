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
} as const;
