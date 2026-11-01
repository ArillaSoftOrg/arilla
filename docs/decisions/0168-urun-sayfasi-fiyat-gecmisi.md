# 0168 — Ürün sayfası: fiyat geçmişi özeti, etkileşimli grafik, başlık ve görsel düzeni

## Bağlam

`/urun/[slug]` üzerinde dört sorun vardı: kare çerçeve geniş ekranda ilk ekranı dolduruyor ve
küçük resimler `cover` ile kırpılıyordu; AliExpress başlıkları (`--text-h1`, kırpmasız) ilk ekranı
yiyordu; fiyat geçmişi sayfanın en altında, katlı bir `<details>` içindeydi; grafik yalnızca iki
noktayı düz bir çizgiyle birleştiriyor, 10,99 → 11,02 USD gibi 0,03'lük değişimi büyük bir yükseliş
gibi gösteriyordu.

Veri incelemesi:

- `price_point` her besleme koşusunda, **fiyat değişmese de** yazılır (`services/ingest/collect/writer.py`).
  Satırın `observed_at` değeri bir **kontrol anıdır**; fiyatın değiştiği an değildir. Değişim tarihi
  tutulmuyor; yalnızca iki gözlem arasında olduğu söylenebilir.
- `getPriceHistory` varsayılan 90 gün alıyordu; kayıtların kalanı API'den gelmiyordu.
- Günlük değer, teklifler arasındaki **en düşük** fiyattır; en ucuz teklif el değiştirdiğinde seri
  fiyat değişimi gibi görünebilir.

## Karar

- **Veri:** sayfa tek ürünün 730 gününü okur (`HISTORY_FETCH_DAYS`; tek ürün + `offer_product_idx` +
  `price_point` PK, tam tablo taraması yok). Varyant geçmişi 90 gün kalır (`variantLowestClaim` aynı
  pencereye bağlı). Migration yok, mevcut kayıt değişmez.
- **Saf mantık `packages/core`:** `@arilla/core/price-history-view` — dönem filtresi
  (7/30/90/365/tümü), min/maks/ortalama (en az 3 gözlem), değişim (tutar + yüzde), boşluk tespiti,
  veri olmayan gün sayısı, bayatlık (son gözlem > 3 gün) ve y ekseni etki alanı. Birim testli.
- **Grafik:** kütüphanesiz SVG, zaman orantılı x ekseni. 1–2 gözlemde **yalnızca nokta**, 3+ gözlemde
  çizgi; uzun boşluklar kesikli. y alanı en az fiyatın %10'u kadardır: küçük oynama küçük görünür.
  İlk gözlemden önceki dönem "Kayıt yok" olarak işaretlenir; nokta sentezlenmez. Para birimi etiketlerde
  ve notta yazılır; yurt dışı seri çevrilmez (karar 0121). Dokunma/fare/klavye ile gözlem seçimi,
  tooltip ve `aria-live` okuma satırı. Min/maks gözlemler halka ile (renk + çizgi biçimi) vurgulanır.
- **Özet:** fiyatın hemen altında yön + tutar + yüzde ve "Fiyat geçmişini gör" (`#fiyat-gecmisi`).
  Kontrol tarihi ile değişim tarihi karıştırılmaz; eski son gözlem ya da kaynakta doğrulanamayan teklif
  için "Son gözlem güncel değil" uyarısı gösterilir.
- **Bölüm açık:** `docs/pages.md` madde 11 "katlanmış" idi; artık açık ve fiyat altından bağlantılıdır.
- **Başlık:** `h1` küçüldü, başlangıçta 3 satır (CSS `line-clamp`), "Tamamını göster". Başlığın tamamı
  DOM'da kalır; veritabanı, `<title>`, JSON-LD değişmez.
- **Görsel:** çerçeve kare ve sınırlı yükseklikte (mobilde daha alçak); görsel `contain`, dogal boyutunu
  aşmaz (küçük görsel büyütülmez); küçük resimler de `contain`.
- **Eylemler:** Kaydet, Fiyat alarmı ve Paylaş tek satırda.

## Reddedilen alternatifler

- Grafik kütüphanesi eklemek: bağımlılık; ihtiyaç saf SVG ile karşılandı.
- Gözlem günlerini "değişim günü" gibi sunmak: veri bunu bilmiyor.
- İstek yolunda tüm geçmişi taramak ya da `price_point` yerine yeni tablo: ayrı iş (aşağıda).

## Ayrı yapılması gerekenler

- Fiyat değişim olayı tablosu (yalnızca değişimde yazılan, `variant_price_event` gibi): kesin değişim
  tarihi ve daha az satır için. Migration + ingest değişikliği gerektirir; bu karar kapsamı dışında.
- Teklifler arası "günlük en düşük" yerine teklif bazlı seri (mağaza değişimi kaynaklı sıçramayı ayırmak).
