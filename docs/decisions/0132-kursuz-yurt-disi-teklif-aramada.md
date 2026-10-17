# 0132 — Güncel kur yoksa da yurt dışı teklifli ürün aramada görünür

**Tarih:** 17 Ekim 2026
**Durum:** Kabul edildi (kullanıcı kararı, 17 Ekim 2026). 0129 B.3'ü değiştirir; 0113 kuralları aynen geçerli.

## Sorun

0129 B.3: yalnızca yurt dışı teklifi olan üründe teklif, son TCMB kuruyla (≤ 4 gün) yaklaşık kuruşa
çevrilerek seçilir; **güncel kur yoksa yurt dışı teklif seçilmez**. Üretimde kur her gün çekilmiyorsa
(`python -m pricing` zamanlaması yok, 0113) yayınlanan AliExpress ürünleri metin, görsel ve sohbet
aramasında ve alternatiflerde yine hiç görünmez; ürün sayfası ve yönetim paneli onları fiyatıyla gösterir.

## Karar

1. `best_offer` kur yoksa da yurt dışı teklifi seçer (TRY her zaman önce; kurla çevrilebilen yurt dışı
   teklif kursuzdan önce).
2. Kursuz teklifte `current_price` **NULL** kalır: kur uydurulmaz, USD tutar kuruş gibi okunmaz.
   `foreignPrice.fxDate` = null; orijinal tutar ve para birimi taşınır.
3. Kart tutarı yalnızca kendi para birimiyle yazar ("30,00 USD"), "Yurt dışı" rozeti ve
   "TL karşılığı için güncel kur yok · Kargo ve vergi belirsiz" (`docs/copy.md` `offers.no_rate`).
4. TL fiyat süzgeci (`price_min`/`price_max`) kursuz ürünü almaz (NULL karşılaştırması). "En iyi
   fırsatlar" zaten yurt dışı teklif almaz (0129 B.4). Sıralama değişmez: dengeli skor fiyat
   yüzdeliğini okur, tutarı okumaz; yurt dışı güven ×0,8 aynen.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Sabit/son bilinen eski kurla çevirmek | Kur uydurmak ya da bayat kuru güncel gibi göstermek (0113) |
| Kur yokken ürünü gizlemek (0129'un hâli) | Ürünün gerçek bir fiyatı var; kur yalnızca TL karşılığı içindir |
| `min_price`'a USD'yi yazmak | USD kuruş gibi okunur; bütçe ve "N mağaza" kirlenir (0113, 0127) |

## Sonuçlar

- Aday kümesi ve sorgu planı 0129 ile aynı (sınırlı `cand`); yalnızca bir `WHERE` koşulu gevşedi.
- Kur tablosu dolunca davranış 0129'daki gibidir (yaklaşık TL + orijinal tutar).
