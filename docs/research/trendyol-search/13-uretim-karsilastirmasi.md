# İki sitemap üretiminin kimlik bazlı karşılaştırması (2026-10-12)

## Yöntem

- **Eski üretim:** `2026-10-11T16:39:34Z`, 337 dosya → tam dizin, 8.126.053 benzersiz contentId
  (`<tmp>/manicepte-trendyol-ids.bin`). Dizin kurulurken `lastmod` birkaç kez kontrol edildi ve değişmedi;
  kurulum yeni üretimden (00:35:46Z) önce bitti.
- **Yeni üretim:** `2026-10-12T00:35:46Z`, 336 dosya. `scripts/trendyol-sitemap-snapshot.ts` ile tamamı
  indiriliyor: yalnızca contentId saklanıyor, kaldığı yerden devam ediyor, 6 sn aralık, 403/429'da durur.
  İndirme sırasında `lastmod` değişirse "karışık üretim" olarak işaretleyip durur.
- **Karşılaştırma:** `scripts/trendyol-sitemap-compare.ts full-index 2026-10-12T00:35:46Z`.
  Dosya numarasından bağımsız, sıralı uint32 kümelerinin kesişimiyle çalışır. Yeni küme eksikse kesin
  eklenen/silinen sayısı **üretilmez**.
- **Kimlik kuralı:** Eski ve yeni küme aynı kuralla çıkarılır (`marka/slug-p-id`, ek yol yok); farklı kural
  sahte fark üretirdi.

## Ara sonuç (yeni üretimin 9/336 dosyası)

| | Değer |
|---|---|
| Üretimler arası süre | **7,94 saat** (16:39:34Z → 00:35:46Z) |
| Dosya sayısı | 337 → 336 |
| Yeni üretimden örnek | 217.133 benzersiz id |
| Eski dizinde de olan | 216.928 (**%99,906**) |
| Kesin eklenen / silinen / birleşim | **Henüz yok**: yeni küme eksik |

Dosya bazlı karşılaştırmanın neden geçersiz olduğu (12 §4): ürünler her üretimde dosyalara yeniden
dağıtılıyor (dosya başına ~24.050 "ekleme" ve ~24.030 "silme" görünüyor).

## Tam sonuç

İndirme tamamlanınca bu bölüme eklenecek: önceden bulunan, yeni eklenen, kaldırılan, toplam benzersiz
(birleşim), değişim oranı.

## Fiyat doğrulama düzeltmesi (bu tur)

`price-observation.ts` karşılaştırma sonuçları artık yalnızca `equal`, `differs` ya da `not-comparable`
olabilir.
- `differs` farkı yazar. Aritmetik uyumu (`arithmeticPercent`, `arithmeticFixedKurus`) ve gözlenen etiketleri
  (`observedTags`) **ipucu** olarak, `verified: false` ile ekler.
- Önceki sürümdeki `percent-discount` / `fixed-discount` / `campaign-tagged` sonuçları, matematikten kampanya
  çıkarımı yapıyordu; **kaldırıldı**.
- Örnek: Samba liste kartı 3.999,50 ile sayfa sepet fiyatı 5.399,25 karşılaştırması `differs` sonucu verir:
  139.975 kuruş fark, aritmetik uyum yok, etiketler "Sepette %25 İndirim" vb. Kampanya hükmü verilmez.
- Testler: 62.

## Fiyat kaynağı araştırması (bu tur)

Somut teknik kanıtı olan yeni bir izinli kaynak bulunamadı. Daha önce elenenler tekrarlanmadı (02–12).
