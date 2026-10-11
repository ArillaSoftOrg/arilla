/**
 * İnternet arama bölümünün metinleri (karar 0102). docs/glossary.md: "satın al",
 * "dupe", "ucuz" geçmez; ALL CAPS yok. İlerleme metni yalnızca gerçekten
 * süren işi söyler: bölüm, sunucuda internet araması sürerken gösterilir.
 */
export const WEB_SEARCH_COPY = {
  /** Arama sürerken (gerçek durum): sunucu internette arıyor. */
  pending: "İnternette alternatifler araştırılıyor",
  heading: "İnternetteki seçenekler",
  note: "Bu sonuçlar anlık olarak mağaza sayfalarından derlendi; katalogumuzda yer almıyor. Fiyat ve stok bilgisini mağaza sayfasında kontrol et. Bu bağlantılar gelir ortaklığı kapsamında değil.",
  exactHeading: "Aynı ürün, farklı mağazalar",
  similarHeading: "Benzer alternatifler",
  sourceBadge: "İnternetten",
  priceUnverified: "Fiyat mağazada",
  outOfStock: "Stokta yok",
  failed: "İnternet araması şu an tamamlanamadı. Katalogdaki sonuçlar yukarıda duruyor.",
  storeCount: (count: number) => `${count} mağaza`,
  offersLabel: "Mağaza seçenekleri",
} as const;
