# 0140 — Keşif defterinde kaldırılma takibi

## Karar

1. Fiyatsız keşif ürünleri teklif olarak yayınlanmaz. Karar 0130 geçerli: keşif satırı
   taslak ürün üretir; fiyat yoksa `held(source_offer_missing)` tutar.
2. `catalog_discovery` tablosu korunur (0073). Eklenen kolonlar: `presence`
   (`present` / `missing` / `removed`) ve `missed_scans`. Satır silinmez.
3. Kaldırılma hesabı yalnızca **tamamlanmış ve doğrulanmış** koşularda ilerler
   (`closeCollectionRun`, sonuç `completed`). Tamamlanmış koşu için:
   - koşunun her `sitemap_file` birimi `done` olmalı;
   - `pending`, `failed`, `blocked` ya da `empty` birim varsa koşu hesaba KATILMAZ.
     `empty` bilinçli olarak engeller: geçici bir hata boş dosya gibi görünebilir.
4. Hesaplanan koşuda görülen satırlar `present`/`missed_scans = 0`; görülmeyenler
   `missed_scans + 1`. Eşik `REMOVAL_MISSED_SCANS = 2`: ardışık iki doğrulanmış tam
   taramada görülmeyen satır `removed` olur.
5. Her kaynak için son finalize edilen koşu `catalog_discovery_scan_state` tablosunda
   tutulur. Aynı koşu iki kez uygulanmaz; daha eski bir koşu daha yeniyi geri alamaz.
6. `removed` satırlardan taslak ürün açılmaz (`catalog_build/discovery.py`).
7. Yaşam döngüsü yeni tablo açmaz: koşular mevcut `collection_run` /
   `collection_unit` altyapısındadır (karar 0117, 0120).

## Gerekçe

- Kaldırma, yanlış pozitif riskiyle yapılır. Kısmi, başarısız veya engellenmiş bir tarama
  ürünleri "yok" saymamalı. Yalnızca tam kapsamlı tarama sayılır.
- İki ardışık eşik, tek bir taramadaki kayıp veriye karşı tampon oluşturur.
- Silme yok: kaldırılmış kayıt geri gelirse aynı satır güncellenir, kimlik kaybolmaz.

## Reddedilen alternatifler

- **Tek taramada kaldırma:** Geçici erişim hatası ürünleri yanlışlıkla kaldırırdı.
- **Yeni sync operasyon tabloları (PR #199):** Aynı işi `collection_run` yapıyor;
  paralel tablo yaratır.
- **Fiyatsız teklif yayını (PR #199):** Karar 0130 ile çelişir ve fiyat değerini
  teklif katmanına sızdırma riski taşır.

## Sınırlar

- Kaldırılma yalnızca tam tarama koşusunda hesaplanır; `presence` değişimi haftalık
  yenilemeye bağlıdır.
- Daha önce taslak olmuş ürünler taslak kalır; `removed` yalnızca yeni taslak açılmasını
  durdurur. Yayınlanmış bir ürünün kaldırılması ayrı bir karardır.
- Sitemap'e giren kurallar (`publication_state = 'published'`, karar 0121) değişmez.
