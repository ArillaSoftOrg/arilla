# 0068 — Chunk'li, checkpoint'li ve toplu SQL'li toplama

> **Eski numara: 0065.** Bu ADR dalda ilk 0065 olarak yazildi; `main`'deki baska kararlarla cakistigi icin 0068'e tasindi. 0049/0051 yorumlarindaki 'karar 0065' / `docs/decisions/0065` ve migration 0051'in COMMENT ON metinleri bu ADR'yi (eski numarasiyla) kasteder; uygulanmis migration dosyalarina bu yuzden dokunulmadi.

**Tarih:** 2026-10-07
**Durum:** kabul edildi (kod ve testler hazır; migration `0051` production'a
henüz uygulanmadı, pilot tekrarı bekliyor)

## Bağlam

`north-sails-turkiye` (572 ürün) üretim pilotunda iki sorun görüldü:

1. **Tek büyük işlem.** `run_ingest` bir merchant'ın bütün kataloğunu tek
   veritabanı işleminde yazıyordu. Uzak Supabase'e bağlantı 42 dakika sonra
   düştü (`server closed the connection unexpectedly`, aynı anda bir DNS
   hatası) ve yapılan tüm iş geri alındı. `halicizade-hali-kilim` (2.155 ürün)
   için aynısı kaçınılmazdı. Hata sonrası yeniden denemek işi baştan
   yapmaktı.
2. **Round-trip maliyeti.** Yazıcı her teklif için 2, her varyant için 5 ayrı
   ifade çalıştırıyordu (`SELECT` mevcut durum, `UPSERT`, stok olayı, son
   fiyat, fiyat olayı). Ölçülen uzak RTT ≈ 158 ms; varyantı çok bir katalogda
   (renk × beden) bu ürün başına dakikalar demek: north-sails'te ilk sayfa
   (50 ürün) 12 dakikadan uzun sürdü. Fixture'da (100 teklif × 3 varyant)
   eski model ≈ 1.700 ifade.

## Karar

### Chunk'li işlem ve kalıcı checkpoint

- Normalize edilen teklifler **100'lük chunk**'larda toplanır (`CHUNK_OFFERS`).
  Her chunk **tek toplu yazım** (aşağıda) + **checkpoint güncellemesi** ile
  **kendi işleminde** commit olur. Teklif başına commit yoktur.
- Chunk boyu: toplu yazımla bir chunk ≈ 9 ifade ≈ 1,5 sn RTT. 100 teklif ≈ 2
  Shopify sayfası (sayfa boyu 50): commit RTT'si ihmal edilir, kesintide
  kaybedilen iş en fazla bir chunk (saniyeler). Daha büyük chunk (500+)
  kesintide daha çok iş kaybettirir ve tek ifadenin paketini büyütür; daha
  küçüğü commit RTT'sini görünür yapar.
- Checkpoint = `ingest_run` satırı (migration `0051`): `updated_at`
  (heartbeat) + `checkpoint` JSONB (`state`, `observed_at`, `chunks`,
  `offers_committed`, `last_external_id`, `resumable`, `resumed_from`) +
  mevcut sayaçlar. Chunk ile **aynı işlemde** ilerler: sayaçlar hiçbir zaman
  yazılmamış işi saymaz. JSON küçük ve düzdür; ham Shopify yanıtı girmez.

### Durum modeli

`running` → **`partial` + `checkpoint.resumable = true`** (kesildi, devam
edilebilir) → `success` ya da `failed`.

- `success` yalnızca tüm katalog yazıldığında ve hiç kayıt reddedilmediğinde.
  Yarım kalan koşu **asla** `success` olmaz.
- Reddedilen kayıt olursa tamamlanan koşu `partial` + `resumable = false`
  (eski anlam).
- Hiç chunk commit edilmeden kesilen koşu `failed` (yazım yok).
- Mevcut `status` CHECK'i ve yönetim konsolu tipleri **değişmedi**: yeni bir
  durum eklemek `IngestStatus` birleşimini, süzgeçleri ve etiketleri üç
  pakete yayardı. Karşılığı: yönetim konsolu "kısmi" gösterir; ayrım
  `checkpoint` ile yapılır. (Açık nokta: konsolda "devam edilebilir"
  rozeti ayrı iştir.)

### Kesintiden devam

Yeniden başlatılan koşu, devam ettirilebilir önceki koşunun `observed_at`'ini
devralır, kataloğu yeniden akıtır ve `last_seen_at = observed_at` olan
(önceki süreçte commit edilmiş) teklifleri atlar; kalanını yazar. Konum
numarası (sayfa/ofset) yerine **kimlik** kullanılır: katalog kesinti sırasında
kaydığında (ürün eklendi/silindi) ne atlanır ne çift yazılır. Devralma 24
saatle sınırlıdır. Bir koşu bir kez devralınır. Yeniden akıtma yalnızca HTTP
okumasıdır (robots ve hız sınırı aynen geçerli), veritabanı yazımı değildir.

`python -m collect` kesilen koşuyu yeni bağlantıyla, deneme × 30 sn bekleyerek
en fazla `--max-attempts` (3) kez kendiliğinden devam ettirir; tükenirse
`partial` kalır ve çıkış kodu 1'dir.

Eşzamanlılık: merchant başına oturum düzeyinde advisory lock
(`pg_try_advisory_lock(4301, merchant_id)`). Kilidi tutan varsa ikinci koşu
`refused:run_in_progress` döner (satır yazmaz). Kilit sahibi yoksa
`checkpoint`'i olan `running` satır ölü süreçten kalmadır; `partial/resumable`
(en az bir chunk kalıcıysa) ya da `failed` yapılır. `checkpoint`'i olmayan
satırlara (link yenileme vb.) dokunulmaz.

`full_dump` pasifleştirmesi artık bellekteki id kümesine değil
`last_seen_at < observed_at` ölçütüne bakar: yeniden başlatılmış koşuda
önceki süreçte yazılanlar "görülmüş" sayılır.

### Toplu SQL

`OfferWriter.write_batch` bir chunk'ın tüm teklif ve varyantlarını `unnest`
ile sabit sayıda ifadeyle yazar: teklif upsert (1, +1 bayat görsel vektörü
silme), `price_point` son kayıt okuma (1) ve ekleme (1), varyant mevcut durum
(1), varyant upsert (1), stok olayı (1), son varyant fiyatları (1), fiyat
olayı (1). Davranış tek tek yazımla aynıdır: aynı `external_id` tekrarlarsa
sonuncusu kazanır, stok/fiyat olayları yalnızca ilk görülmede ve değişimde,
`product_id`'ye dokunulmaz. 2.000'den çok varyant ifadeler halinde bölünür.
Ölçüm (fixture, 100 teklif × 3 varyant): ~1.700 ifade → 8 yazım ifadesi
(bütün koşu 16 ifade). Yük `unnest` dizisi olduğu için ifade başına parametre
sınırına takılmaz.

### Fiyat geçmişi: `price_point` = değişim olayı

**Sözleşme.** `price_point` fiyat **değişim olayıdır** (fiyat, liste fiyatı ya
da stok değiştiğinde yazılır); "bu teklif bu gün görüldü" kanıtı **değildir**.
Tazelik `offer.last_seen_at`'tir (her başarılı toplamada güncellenir). Aynı
koşu yeniden denense bile `(offer_id, observed_at)` çakışması `DO NOTHING`.
Kullanıcı linki yolu (`collect.link`) her çözümlemede nokta yazmaya devam eder.

`price_point`'i gözlem sıklığı ya da "görüldü" kanıtı olarak okuyan üç yer bu
sözleşmeye taşındı:

- **`getPriceHistory`** (ürün sayfası grafiği) ve **`getVariantPriceHistory`**
  (çok boyutlu teklifte "görüldüğü günler"): ortak
  `product/offer-price-days.ts`. Günlük seri ilk fiyat olayından
  `offer.last_seen_at` gününe kadar kurulur; her günün fiyatı o güne kadarki
  son olaydır (gün içinde değişim varsa en düşüğü). Seri `last_seen_at`'te
  biter: kaybolan teklifin son fiyatı sonsuza dek "güncel" sayılmaz. Hiçbir
  fiyat uydurulmaz; eskiden günlük toplamanın ürettiği `price_point`
  günlerinin türetilmiş halidir ve çıktı biçimi değişmedi.
- **`product_price_stats`** (`similarity/prices.py`): medyan/yüzdelik/30 gün
  penceresi artık olay sayısına değil **süreye** bağlı. Seri değişim
  olaylarından günlük etkin fiyat örnekleriyle (`carry_forward`) açılır;
  pencere öncesindeki son olay da okunur (90 gündür değişmeyen fiyat istatistiksiz
  kalmaz). Sıraya bağlı olanlar (düşüş sayısı, sahte indirim) gerçek olay
  zamanlarıyla hesaplanır.
- **Sitemap uygunluğu** (`MIN(observed_at)` = ilk fiyat kaydından beri geçen
  süre) ve **Keşfet düşüşleri** (`product_price_stats`) değişmedi: ilk olay
  korunur, düşüşler zaten olay sayar.

Yeni kolon gerekmedi: varyant düzeyi tazelik de `offer.last_seen_at` +
`variant_price_event` (zaten yalnızca değişimde yazılır) ile karşılanır.

### Görsel ve medya

Toplama **görsel indirmez ve görsel baytı saklamaz**; `offer` yalnızca
`image_url` ve (zenginleştirme aşamasında) `image_hash` tutar. Ham görsel
için kalıcı yer PostgreSQL değil Cloudflare R2 / `media.manicepte.com`'dur.
R2 aynalama **ayrı, yeniden çalıştırılabilir bir aşama** olarak tasarlanır
(bu kararda uygulanmadı): `image_url`'i olup henüz aynalanmamış offer'ları
batch'ler halinde seçer, indirir, R2'ye yazar ve sonucu yalnızca URL/hash
alanlarına işler; katalog işlemine bağlı değildir, kesilirse kaldığı yerden
devam eder (aynı "seçilmemişleri al" deseni `enrich`'te zaten var).

### Ham yük saklanmaz

`offer.attributes_raw` ham Shopify JSON'u değildir: yalnızca ≤ 200 karakterlik
düz skalerler (üretimde ortalama ≈ 395 bayt, en çok 627). Eşleştirme ve kalite
araçları `gtin`, `sku`, `color`, `id` anahtarlarını okur. Teknik alanları
(`position`, `grams`, `taxable`, …) budamak yararlıdır ama çözümleyicinin
(`resolve`) hangi anahtarları okuduğu denetlenmeden yapılmaz; ayrı iş.

## Reddedilen alternatifler

- **Yalnızca timeout'u büyütmek:** bağlantı kopması ve DNS hatası süreden
  bağımsız; her yeniden deneme işi baştan yapar.
- **Teklif başına commit:** RTT'yi ikiye katlar, kazanç sağlamaz.
- **Konum (sayfa numarası) tabanlı devam:** katalog kayınca ürün atlar.
  Kimlik tabanlı devam bunu önler.
- **Yeni `interrupted` durumu:** CHECK + üç paketlik tip/etiket değişikliği;
  `partial` + `resumable` aynı bilgiyi taşır.
- **`checkpoint`'i ayrı tabloda tutmak:** `ingest_run` zaten koşu başına tek
  satır ve yönetim ekranı onu okuyor; ek tablo ek bağlantı noktası olurdu.
- **Görseli toplama sırasında indirmek:** binlerce görsel katalog yazımını
  bloke eder ve kesintide yarım iş bırakır.
