/** Gerçek kareler: 2 Kasım 2026, metinle arama ve bütçe örneği.
 * Web ve mobil ayrı kayıtlardır.
 */
const BASE = "/how-it-works/2026-11-02";

export const GUIDE_STEPS = [
  {
    id: "tarif",
    title: "Aradığını anlat",
    description:
      "Ürün adını, markayı ya da aklındaki modeli kendi cümlelerinle yaz. Başlamak için kısa bir tarif yeterli.",
    example: "adidas Samba kadın ayakkabısı",
    alt: "Arama kutusuna adidas Samba kadın ayakkabısı yazılmış gerçek ana sayfa.",
    caption: "Bu örnekte arama, ürünün adı yazılarak başlıyor.",
    desktopCaption: "Bu örnekte arama, ürünün adı yazılarak başlıyor.",
    desktop: { src: `${BASE}/search-desktop.png`, width: 1265, height: 816 },
    mobile: { src: `${BASE}/search-mobile.png`, width: 375, height: 780 },
  },
  {
    id: "sonuclar",
    title: "Seçeneklere bak",
    description:
      "Ürünleri, fiyatları ve mağazaları incele. Aklındaki seçeneğe yaklaşmak için aynı sohbete devam edebilirsin.",
    example: "Bu aramada önce 94 seçenek listeleniyor.",
    alt: "İlk adidas Samba aramasının gerçek ürün sonuçları; henüz bütçe sınırı eklenmemiş.",
    caption: "Bütçe eklenmeden önceki ürün seçenekleri.",
    desktopCaption: "İlk aramadaki ürünler, mağaza adları ve fiyatlar. Henüz bütçe sınırı yok.",
    desktop: { src: `${BASE}/results-desktop.png`, width: 1265, height: 889 },
    mobile: { src: `${BASE}/results-mobile.png`, width: 375, height: 812 },
  },
  {
    id: "butce",
    title: "Tercihlerinle daralt",
    description:
      "Bütçeni ya da aradığın bir ayrıntıyı ekle. Bu örnekte 5.000 TL bütçe belirtildiğinde 94 seçenek 37’ye daralıyor.",
    example: "Bütçem en fazla 5.000 TL olsun.",
    alt: "Aynı sohbette en fazla 5.000 TL bütçe mesajı ve buna verilen gerçek yanıt.",
    caption: "Bütçe, aynı sohbete eklenen yeni bir mesajla belirtiliyor.",
    desktopCaption:
      "Bütçe mesajından sonra liste, en fazla 5.000 TL ölçütüyle 37 sonuca daralıyor.",
    desktop: { src: `${BASE}/budget-desktop.png`, width: 1265, height: 889 },
    mobile: { src: `${BASE}/budget-mobile.png`, width: 375, height: 844 },
  },
] as const;
