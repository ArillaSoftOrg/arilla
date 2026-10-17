# 0127 — Yurt dışı (USD) teklifli ürünün fiyat özeti ve gösterimi

**Tarih:** 17 Ekim 2026
**Durum:** Kabul edildi. 0113, 0114 ve 0121'in para birimi kurallarını korur; özetin eksik
kalan yarısını tamamlar.

## Sorun

Üretimde yayınlanan ilk 10 AliExpress ürünü (`publication_state = published`, aktif USD
teklifi doğru ürüne bağlı) yönetim panelinde **10/10 "Fiyatsız", "Aktif mağazası yok" ve
"Fiyat özeti 7+ gündür yenilenmedi"** görünüyordu. Ürün sayfası da "Şu an bu ürün için
mağaza fiyatı yok" diyordu.

Koddan doğrulanan nedenler:

1. **Özet yalnızca TRY sayar** (`refresh-aggregates.ts`, `product_aggregates.py`:
   `AND o.currency = 'TRY'`; karar 0121 madde 7). USD-only ürün için `min_price = NULL`,
   `offer_count = 0` çıkar. Panel "Fiyatsız" = `min_price IS NULL`, "Aktif mağazası yok" =
   `offer_count = 0` okuyordu.
2. **Özet hiç yazılmıyordu.** Yenileme yalnızca değer değişince yazar
   (`IS DISTINCT FROM`). USD-only ürünün hesaplanan özeti `(NULL, NULL, 0, 0)` ürünün
   varsayılanıyla aynı olduğundan `price_updated_at` NULL kaldı; panel NULL'u
   "7+ gündür yenilenmedi" sayar.
3. **USD tutar TL gibi yazılıyordu** — yönetim ürün detayındaki teklif tablosu ve
   `/yonetim/katalog/teklifler` her teklifi `formatKurus` ile "19,99 TL" biçimliyordu.
4. Ürün sayfası başlığı yalnızca TL tekliflerden beslenir; yurt dışı teklif yalnızca alttaki
   "Yurt dışı teklifi" bölümündeydi.

"Aktif mağaza" kuralı (`merchant.is_active`) kendi başına neden değildir: TRY süzgeci
mağaza durumundan bağımsız olarak sayacı 0 yapar. Mağaza kapalıysa ürün sayfası ve yeni
sayaç da teklifi saymaz (bilerek).

## Karar

1. **`product.foreign_offer_count`** (migration 0076, yalnızca ekleme, sabit varsayılan):
   aktif mağazanın fiyatlı aktif TRY dışı teklifi olan farklı mağaza sayısı. Kolon tanımı
   yurt dışı arama dalınınkiyle (`feature/foreign-products-in-search`) aynıdır.
   `min_price`, `max_price`, `offer_count`, `in_stock_count` **TRY-only kalır**: USD tutar
   kuruş değildir, TL'ye çevrilip saklanmaz.
2. USD-only üründe sayaç 0→1 değiştiği için özet yazılır, `price_updated_at` dolar.
3. **Yönetim paneli:** "Aktif mağazası yok" = TRY ve yurt dışı sayacı 0; "Fiyatsız" =
   TRY fiyatı yok **ve** yurt dışı fiyatlı teklif yok. Yeni bilgi sayacı
   "Yalnız yurt dışı fiyatlı". Liste ve detay, para birimi başına en düşük yurt dışı
   fiyatı **kendi para biriminde** gösterir; teklif tabloları her tutarı kendi para
   birimiyle yazar.
4. **Ürün sayfası:** TL teklifi yoksa başlıkta yurt dışı teklif kendi para birimiyle,
   gözlem zamanıyla; TCMB kuru 4 günden yeniyse yaklaşık TL (kur tarihiyle), yoksa
   "güncel kur olmadığı için TL karşılığı verilmiyor". Çıkış `/git` üzerinden
   (kural 8); `click.price_at_click` TRY dışında boş kalır (0113).
5. **Arama değişmez.** Arama, kartlar, bütçe süzgeci ve site haritası yalnızca TRY özetini
   okur; USD-only ürün aramada görünmez (0121'deki açık ürün kararı, arama dalının işi).

## Reddedilen alternatifler

| Alternatif | Neden reddedildi |
|---|---|
| USD'yi kurla TL'ye çevirip `min_price`'a yazmak | Kur değiştikçe saklanan "fiyat" uydurma olur; bütçe/sıralama doğrulanmamış toplamı TL sanar (0113) |
| TRY süzgecini kaldırmak | USD cent kuruş gibi okunur: 19,99 USD "19,99 TL" olur |
| Panel sayaçlarını her açılışta canlı `EXISTS` ile hesaplamak | Yayınlanmış katalog milyonlara çıktığında 5 sn zaman aşımı; özet zaten var |
| Değişmese de her yenilemede `price_updated_at` yazmak | Günlük onarım tüm yayınlanmış satırları yeniden yazar (WAL, şişme) |

## Sonuçlar

- Üretimde migration 0076 uygulandıktan sonra 10 ürünün sayacı ilk günlük
  `product_aggregates` onarımında (ya da `python -m similarity --prices`) yazılır; elle
  publish/gate/build gerekmez.
- Arama dalının 0076 dosyası bununla çakışır: dal bu sürümü almalı, `offer_try_product_idx`
  indeksini karar 0125 gereği ayrı `kind: concurrent` migration'ına taşımalıdır.
- "7+ gündür yenilenmedi" özetin son **değiştiği** anı ölçer (0051); fiyatı hiç değişmeyen
  ürün 7 gün sonra yine listelenir. Bu davranış değiştirilmedi.
- Marka ve kategori uydurulmaz (0121 madde 8): 10 ürün "Markasız/Kategorisiz" kalır.
