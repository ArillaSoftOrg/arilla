/**
 * Sohbet sonuc ozeti (karar 0200): "12 magazadan 20 urun". Saf fonksiyon; DB/model yok.
 *
 * Sayilar GOSTERILEN katalog kartlarindan gelir (en fazla `CHAT_RESULT_LIMIT`), toplam
 * eslesmeden degil: ekrandaki kart sayisiyla ozet tutarli kalir. Magaza sayisi, her urunun
 * secilen en iyi teklifinin magazasidir (`merchantName`); bir urunun baska magazalardaki
 * teklifleri sayilmaz, yani alt sinirdir. Magaza adi hic yoksa magaza sayisi `null` (gosterilmez).
 * Internet (web) kartlari katalog verisi degildir ve sayiya katilmaz.
 */
export interface ResultSummary {
  productCount: number;
  /** Farkli en iyi teklif magazasi sayisi; bilinmiyorsa `null`. */
  storeCount: number | null;
}

export function summarizeResults(
  items: ReadonlyArray<{ merchantName?: string | null }>,
): ResultSummary {
  const stores = new Set<string>();
  for (const item of items) {
    const name = item.merchantName?.trim().toLocaleLowerCase("tr-TR");
    if (name) stores.add(name);
  }
  return { productCount: items.length, storeCount: stores.size > 0 ? stores.size : null };
}
