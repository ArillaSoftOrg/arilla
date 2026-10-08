/**
 * `/trendler` metinleri (arayuz Turkce, ALL CAPS yok; "satin al", "dupe",
 * "ucuz" gecmez - docs/glossary.md). Trend basliklari ve aciklamalari DB'dedir
 * (`trend` tablosu); burada yalnizca sayfa kromu.
 */
export const TREND_COPY = {
  pageTitle: "Trendler",
  metaTitle: "Trendler – Arilla",
  metaDescription:
    "Öne çıkan stiller ve ürün fikirleri. Her trendde ürünleri farklı mağazalardaki fiyatlarıyla karşılaştırabilirsin.",
  pageDescription:
    "Öne çıkan stiller ve ürün fikirleri. Bir trende gir, ürünleri mağazalar arasında karşılaştır.",
  navLabel: "Trend bölümleri",
  back: "Trendler",
  backAria: "Tüm trendlere dön",
  productsHeading: "Bu trendin ürünleri",
  loading: "Trendler yükleniyor",
  loadingDetail: "Trend ürünleri yükleniyor",
  homeAllLink: "Tüm trendleri gör",
  emptyTitle: "Şu an gösterilecek trend yok",
  emptyDescription: "Trendler hazırlanırken ana sayfadan arama yapabilirsin.",
  emptyAction: "Ana sayfaya dön",
  sections: {
    featured: "Öne Çıkanlar",
    now: "Şu An Trend",
    moda: "Moda",
    guzellik: "Güzellik",
    "ev-yasam": "Ev & Yaşam",
    ogrenci: "Öğrenci",
    seasonal: "Sezonluk",
    all: "Tüm Trendler",
  },
} as const;

export type TrendSectionKey = keyof typeof TREND_COPY.sections;

/** "+8 ürün" (docs/copy.md: ürün sayısı). */
export function moreProductsLabel(extra: number): string {
  return `+${extra} ürün`;
}

/** "24 ürün". */
export function trendProductCountLabel(count: number): string {
  return `${count.toLocaleString("tr-TR")} ürün`;
}
