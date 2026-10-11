/**
 * İnternet kaynaklı kartların metinleri (karar 0102, 0106). docs/glossary.md:
 * "satın al", "dupe", "ucuz" geçmez; ALL CAPS yok. Kartlar katalog kartlarıyla
 * aynıdır; kaynağı teknik terimlerle anlatan metin yoktur.
 */
export const WEB_SEARCH_COPY = {
  /** Arama sürerken (gerçek durum): sunucu ek mağazalarda arıyor. */
  pending: "Diğer mağazalarda da aranıyor",
  /** Kart fiyatı doğrulanamadıysa. */
  priceUnverified: "Fiyat mağazada",
  outOfStock: "Stokta yok",
  storeCount: (count: number) => `${count} mağaza`,
  /** Katalog bos, internet aramasi tamamlanamadi (sifir urun ile ayri durum). */
  failed: "İnternet araması şu an tamamlanamadı; biraz sonra tekrar deneyebilirsin.",
  suggestionsTitle: "Google arama önerileri",
  offersToggle: "Mağazaları göster",
  /** Izgara sonunda tek satır: gelir ortaklığı ve doğrulama bilgisi. */
  footnote:
    "Bazı mağaza bağlantıları gelir ortaklığı kapsamında değildir. Fiyat ve stok bilgisini mağaza sayfasında kontrol et.",
} as const;
