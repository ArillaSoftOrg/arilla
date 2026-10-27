# 0156 — Teklif tazeliği: doğrulanamayan fiyat güncel gibi gösterilmez

**Tarih:** 27 Ekim 2026
**Durum:** Önerildi (PR). Üretimde hiçbir beslemede politika tanımlı değil; etkinleştirme ayrı ve
onaylı bir adımdır (`docs/ops.md`). Migration yok. Üretim verisine dokunulmadı (yalnızca salt okunur
sorgular).
**İlişkili:** 0112 (üyelik ve deaktivasyon), 0114, 0117 (`no_deactivate`), 0121/0127 (yurt dışı
teklif gösterimi), 0129 (aramada yurt dışı), 0145 (günlük tazeleme; okuma yolu koruması "ayrı iş"
olarak bırakılmıştı), 0152 (besleme bütünlüğü).

## 1. Sorun (27 Ekim 2026, üretim, salt okunur)

AliExpress beslemesi 7 (`10-25$`) `no_deactivate` ile çalışıyor (0117): kaynakta olmayan teklif
pasifleşmez. Aramanın `best_offer` seçimi ve ürün sayfasının yurt dışı listesi yalnızca `is_active`
ve stok bakar; bu yüzden beslemede artık olmayan teklifin eski fiyatı "güncel" gibi gösteriliyor.

| Son görüldüğü sürüm | Teklif | Ürüne bağlı | Yaş | Teklifsiz başarılı gün |
| --- | --- | --- | --- | --- |
| #10 (güncel) | 2.660.070 | 1.756.864 | 0,5 gün | 0 |
| #7 (25 Ekim) | 735.091 | 429.298 | 2,3 gün | 2 |
| #4 (15 Ekim) | 589.232 | 583.316 | 12,8 gün | 3 |
| **Doğrulanamaz adayı** | **1.324.323** (%33,2) | **1.012.614** | | |

AliExpress ürünleri 2.769.478; ürün ile teklif 1:1 olduğu için 1.012.614 ürünün **tek** teklifi
beslemede yok (%36,6). Hepsi etkin ve stokta; fiyat geçmişi `price_point`'te duruyor.

**Neden kayboldukları büyük ölçüde bilinmiyor.** Komşu fiyat dilimleri ayrıca indirilip kimlik
düzeyinde karşılaştırıldı (ham dosya saklanmadı, yalnızca kimlik/fiyat):

| Dilim | Kayıt | Feed 7'nin eski teklifiyle eşleşen | Bunlardan ürüne bağlı | Fiyat izi |
| --- | --- | --- | --- | --- |
| 25–40 $ (feed 8) | 1.663.536 | 60.324 | 56.983 | yeni/eski fiyat medyanı 1,115 |
| < 10 $ (feed 14) | 1.720.892 | 21.937 | 17.456 | medyan 0,652 |
| hot products (feed 11, **yarım**) | ≥1.888.206 | 23.009 | 15.793 | medyan 1,000; eski/güncel grupta aynı oran (~%1,8) |

Dilim geçişi 1.012.614 eski ürünün yalnızca **%7,35'ini** (feed 8 + 14: 74.439) açıklıyor. Kalan ~%93,
diğer dilimlerde (13, 16, 15, 12, 9: taranmadı), kaynakta kalkmış, stok dışı ya da seçimden çıkmış
olabilir; ayırt edilemedi. Bu yüzden "başka dilimde güncel duruyor" varsayımı yapılmaz ve ek besleme
açmak güncelliğin çözümü değildir.

**Dönüş var.** 15 → 25 Ekim arasında beslemeden ayrılan 983.822 teklifin en az ~338 bini (çıkarım:
ilk görülme tarihi + grup sayıları; ham dosyalar saklanmadığı için doğrudan değil) 26 Ekim'de geri
geldi. Kısa bir yokluk kayıp kanıtı değildir.

## 2. Karar

Fiyatı doğrulanamayan teklif **okuma yolunda** süzülür. Teklif silinmez, pasifleştirilmez; `product_id`,
`offer_id`, `feed_source_offer` ve `price_point` değişmez; geri dönen teklif kendiliğinden yeniden görünür.

1. **Besleme başına açık politika:** `feed_source.config.freshness` =
   `{unverified_after_days, min_absent_days?, source_stale_after_days?}` (`docs/ops.md`).
   Alan yoksa ya da bozuksa (metin, eksi, çok büyük) politika yoktur; sorgu hata vermez.
2. **Üç kanıt birlikte aranır** (`packages/core/src/offers/freshness.ts`, `offerVerifiedSql`):
   - **Teklif yaşı:** üyeliğin son görülmesi `unverified_after_days`'ten eski.
   - **Başarılı sürüm geçmişi:** son görüldüğü sürümden sonra, teklifsiz `complete` sürümler en az
     `min_absent_days` (varsayılan 2) **farklı UTC gününe** yayılmış. Kaynağın başarısız olduğu günler
     sürüm üretmez ve "kayboldu" sayılmaz; aynı gündeki iki sürüm tek gündür; tek başarılı sürüm
     kayıp kanıtı değildir.
   - **Kaynak sağlığı (isteğe bağlı):** `source_stale_after_days` içinde başarılı sürüm yoksa beslemenin
     tüm teklifleri doğrulanamaz (neden teklif değil kaynak). Politikalı besleme `disabled`/`gone`
     ise de öyle. Sınır tanımsızsa kaynak kesintisi teklifleri gizlemez (0145'in "yanlış alarmda tüm
     AliExpress aramadan düşer" kaygısı).
3. **Birden çok beslemede üyelik** (fiyat bandı geçişi, 0112 §8): herhangi bir politikalı üyelik tazeyse
   teklif doğrulanmıştır.
4. **Politikasız besleme ve beslemesiz mağaza hiç etkilenmez.** Ölçüm: Hepsiburada'nın 2.017 teklifi
   (besleme 17, toplayıcı) 16 Ekim'den beri görülmedi (10,9 gün) ve yalnızca 17 Ekim'de iki ayrı
   toplayıcı sürümü var. Salt takvim yaşı kuralı (3/7/10 gün) bu 2.017 güncel teklifin tamamını yanlışlıkla
   gizlerdi. Burada ne politika var (açık seçim) ne de "en az 2 farklı başarılı gün" şartı sağlanıyor.
   Hepsiburada'ya politika vermek ayrı bir karardır (taranan alt küme; tam sürüm sözleşmesi yok).

### Davranış

| Yüzey | Doğrulanamayan teklif |
| --- | --- |
| Metin araması (`/ara`, sekmeler) | `best_offer`'a girmez; ürünün başka doğrulanmış teklifi yoksa ürün sonuçta yoktur. TRY teklifi doğrulanmışsa ürün TRY teklifiyle kalır |
| Benzer ürün, alternatif şeridi, görsel arama | `best_offer`'ı olmayan ve doğrulanamayan teklifi olan ürün "fiyatsız kart" olarak girmez; eski davranış (teklifi hiç olmayan ürün) aynen kalır |
| Ürün sayfası | Sayfa açılır (adres, geçmiş, bağlar yerinde). Yurt dışı başlığı ve listesi doğrulanmış teklifle sınırlı; hiçbir teklif gösterilemiyorsa "Güncel fiyat doğrulanamadı. Yurt dışı teklifi en son {tarih} tarihinde görüldü." Fiyat ve çıkış düğmesi yok |
| `/teklifler` | Eşleşmemiş doğrulanamayan teklif listelenmez |

Doğrulanamayan fiyat "eski fiyat" etiketiyle de gösterilmez: kullanıcı kaynakta olmayabilecek bir
fiyata yönlendirilirdi (fiyat uydurulmaz ilkesi, 0113).

### Kapsam ve tutarlılık

Aynı koşul, teklif fiyatı gösteren tüm yüzeylere uygulanır (envanter ve bilerek dışarıda bırakılanlar:
§8). Politikanın TRY beslemesine verilmesi de aynı kuralları izler; bu karar yine de yalnızca yurt dışı
(AliExpress) beslemesi için etkinleştirilmesini önerir.

## 3. Eşik senaryoları (ölçüm)

Gerçek `offerVerifiedSql` koşulu, 3,98 milyon teklifin tamamına, politika yalnızca ölçüm için
`unverified_after_days = T` verilerek uygulandı (27 Ekim, salt okunur). `min_absent_days = 2`.

| T (gün) | Gizlenen teklif | Gizlenen ürün | AliExpress ürünlerinin payı |
| --- | --- | --- | --- |
| 3 | 589.232 | 583.316 | %21,1 |
| 7 | 589.232 | 583.316 | %21,1 |
| 10 | 589.232 | 583.316 | %21,1 |
| 14 | 0 | 0 | %0 |

Taranan 3.986.410 teklifin içinde Hepsiburada'nın 2.017 teklifi de var; simülasyonda politika **tüm**
beslemelere verildiği hâlde hiçbiri gizlenmedi (son görülmesinden sonra yalnızca 0–1 farklı başarılı
gün var). Tam tarama ~55–60 sn sürer; yalnızca tanıdır, istek yolunda çalışmaz.

Hiç teklif geri dönmezse 25 Ekim grubu (735.091 teklif / 429.298 ürün) eşiği şu tarihte aşar: T=3 →
28 Ekim, T=7 → 1 Kasım, T=10 → 4 Kasım, T=14 → 8 Kasım; 15 Ekim grubu T=14'ü 29 Ekim'de aşar.
Sınırdaki toplam 1.012.614 ürün (%36,6).

**Öneri: `unverified_after_days = 10`.** Kaynak günlük güncelleniyor ve tek güncellemede teklifin %28'i
değişebiliyor; 3 günlük pencere dönen teklifleri yanlışlıkla gizler, 14 gün bugün hiçbir şeyi yakalamaz.
10 gün, 15 Ekim'den beri görünmeyen 583.316 ürünü hemen, 25 Ekim grubunu ise dönmek için 4 Kasım'a
kadar süre tanıyarak yakalar. Eşik ölçülen dönüş süresine göre ayarlanır; dönüş verisi yalnızca 4 tam
sürümle sınırlıdır, 2–4 hafta izlenmelidir.

## 4. Performans

Ölçüm: üretim (22 GB veritabanı), `EXPLAIN (ANALYZE, BUFFERS)`, arama adayı kümesi (1.000 ürün,
1.000 teklif), tüm veri sıcak:

| Varyant | Süre |
| --- | --- |
| Koşul yok (önceki hâl) | 2,4 ms |
| Koşul var, politika yok (üretimin bugünkü durumu) | 5,0 ms |
| Koşul var, politika 10 gün açık (simüle) | 11,5 ms |

Kural teklif başına `feed_source_offer_offer_idx` + `feed_source` birincil anahtarı kullanır; yaş
eşiği aşılmışsa ~on satırlık `source_snapshot` taranır. Yeni indeks gerekmedi. Yalnızca sınırlı aday
kümesine uygulanır (tüm tabloya değil). Örneklemde teklifin %23,3'ü gizlendi (n=1000), tam sayımla
(%21,1 ürün) uyumlu.

## 5. Etkinleştirme ve geri alma

`docs/ops.md` "Teklif tazeliği politikası": tek satırlık, idempotent `UPDATE feed_source SET config =
jsonb_set(...)`; geri alma `config - 'freshness'`. İkisi de veri değiştirmez ve bir sonraki istekte
geçerli olur. Bu PR ayarı uygulamaz.

## 6. Sınırlar ve açık işler

- **Aday penceresi** §8'de çözüldü (ürün düzeyi koşul pencereden önce). Depolanan özetler
  (`offer_count`/`foreign_offer_count`) doğrulanamayan teklifi hâlâ sayar; özetleri tazelikle yeniden
  hesaplamak migration ve ~1 milyon ürün satırı yazımı (WAL) gerektirir, gerekmedi.
- **Sitemap / SEO:** doğrulanamayan ürün sayfası yine açılıyor ve sitemap'te kalabilir.
- **Kaynak kesintisi sınırı** (`source_stale_after_days`) ölçülen güncelleme sıklığıyla belirlenmeli.
- **Pasifleştirme ve `no_deactivate`** bu kararın konusu değildir: %10 tavan ve ~%28'lik güncelleme
  rotasyonu varken kaldırmak ya sessizce bir şey yapmaz ya da dönen teklifleri aramadan düşürür.
- Dönüş ve yokluk süresi için sürüm başına üyelik geçmişi saklanmıyor; teklif bazlı yokluk sayacı
  (migration) ayrı değerlendirilmeli.

## 7. Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Salt takvim yaşı (3/7/10/14 gün) | Hepsiburada'nın güncel 2.017 teklifini gizler; kaynak kesintisini "teklif kayboldu" sayar |
| `offer.last_seen_at` ile yaş | Değişmeyen satır yeniden yazılmaz, bir sürüm geride kalır (26 vs 27 Ekim); doğru kaynak `feed_source_offer` |
| `is_active = false` yazmak / `no_deactivate`'i kaldırmak | Geri alınamaz hız, %10 tavan, dönen tekliflerde dalgalanma; milyonluk özet yazımı |
| Fiyatı "eski fiyat" notuyla göstermek | Doğrulanamayan fiyat gösterilmez; kullanıcı kaynakta olmayabilecek fiyata gider |
| Komşu dilimleri açıp sorunu çözmek | Eski ürünlerin yalnızca %7,35'ini açıklıyor; +3,3 milyon teklif, ~31 GB ilk yükleme WAL'ı (tahmin) |
| Yeni kolon (`stale_since`) | Migration ve milyonluk yazım gerektirir; kural okuma anında hesaplanabiliyor |

## 8. Ek (#233 sonrası): aday penceresi ve yüzey tutarlılığı

### 8.1 Aday penceresi

Metin aramasının aday dalları `LIMIT 1000` ile indeksten kesilir (karar 0129). Koşul yalnızca
sonradan `best_offer`'da uygulandığı için doğrulanamayan ürünler pencereden ÖNCE yer işgal ediyordu.
Ölçüm (üretim, gerçek aday SQL'i, politika 10 gün simüle):

| Sorgu | Pencere (eski) | Doğrulanamayan | Pay | Filtreli pencerede doğrulanamayan |
| --- | --- | --- | --- | --- |
| led | 1.003 | 280 | %27,9 | 0 (pencere 1.003) |
| usb | 1.013 | 249 | %24,6 | 0 (1.013) |
| case | 1.004 | 215 | %21,4 | 0 (1.004) |
| usb cable | 1.000 | 174 | %17,4 | 0 (1.000) |
| wireless bluetooth headphones | 704 | 112 | %15,9 | 0 (648) |

**Çözüm:** `candidateBase`'e ürün düzeyi `productHasVerifiableOfferSql`: ürünün etkin teklifleri varsa
ve hiçbiri doğrulanmış değilse ürün aday olmaz; etkin teklifi hiç olmayan ürün eskisi gibi kalır
(özet gecikmesi). Hiçbir beslemede politika yoksa ilk kol tek seferlik (InitPlan) `TRUE` olur,
ürün başına teklif sorgusu çalışmaz (planda alt planlar "never executed").

**Performans** (`EXPLAIN ANALYZE`, ikinci koşu, tüm veri sıcak; A = eski, B = filtre var/politika yok =
üretimin bugünkü durumu, C = politika 10 gün simüle):

| Sorgu | A | B (JIT açık) | B (JIT kapalı) | C (JIT kapalı) |
| --- | --- | --- | --- | --- |
| led | 31 ms | 596 ms | 36 ms | 51 ms |
| usb | 16 ms | 575 ms | 20 ms | 38 ms |
| case | 35 ms | 625 ms | 36 ms | 54 ms |
| usb cable | 25 ms | 589 ms | 22 ms | 54 ms |
| wireless bluetooth headphones | 51 ms | 1.709 ms | 53 ms | 77 ms |

İlk ölçümde filtre, politika olmasa bile sorguyu 16-60 ms'den 570-1.700 ms'ye çıkardı. Neden **JIT**:
aday aşaması `enable_seqscan = off` ile çalışır (karar 0129); `feed_source` (17 satır) üzerindeki
zorunlu sıralı tarama 1e10 ceza maliyeti alır, toplam plan maliyeti `jit_above_cost` (100.000)
eşiğini aşar ve 103 fonksiyon JIT ile derlenir. Plan şekli ve tampon sayıları aynıydı (941 → 951).
`withCandidatePlan` artık `jit`'i de aynı işlemde kapatır (`set_config(..., true)`, işlem bitince düşer);
bu sorgular kısa ve indeksli, JIT'ten kazanmaz. Politika açıkken maliyet +15-25 ms.

### 8.2 Yüzey envanteri

| Yüzey | Durum |
| --- | --- |
| `best_offer` (metin, closest_match, alternatifler, görsel), aday penceresi | Uygulandı (#233 + bu PR) |
| Ürün sayfası yurt dışı başlık/liste ve "doğrulanamadı" özeti, `/teklifler` | Uygulandı (#233) |
| `compareMerchants`, `getPriceComparison` (varyant satırları ve toplu yükleme), `getSizeOptions`, `getVariantPriceHistory`, link araması kart fiyatı | Uygulandı (bu PR) |
| `getPriceHistory` | Bilerek dışarıda: geçmiş gözlemlerdir, fiyat geçmişi korunur |
| `getProductGallery` | Bilerek dışarıda: görsel, fiyat değil |
| Sitemap uygunluğu | Bilerek dışarıda: depolanan TRY `offer_count >= 2` özetine bakar; yurt dışı teklif sayılmaz |
| `product.offer_count`, `min_price`, `foreign_offer_count` | Bilerek dışarıda: depolanan özet (yukarı) |
| Görsel arama ANN penceresi | Açık iş: komşu sınırı vektör aşamasında uygulanır; AliExpress teklifleri için `embedding` tablosu boş, ölçülemedi |
| Yönetim tanısı (`search-explain` sayıları) | Bilerek dışarıda: ham sayıları göstermesi amaçtır |

### 8.3 Etkinleştirmeden önceki ölçüm (27 Ekim, üretim, salt okunur, nihai SQL)

Politika yalnızca ölçüm için verilerek (`unverified_after_days = 10`, tüm beslemelere) tam tabloda:

| Ölçü | Değer |
| --- | --- |
| Etkin teklif | 3.986.410 |
| Gizlenecek teklif / ürün | **589.232 / 583.316** (yayındaki 2.771.495 ürünün %21,0'i) |
| Gizlenen ama son başarılı sürümde olan (güncel) teklif | **0** |
| Gizlenen Hepsiburada teklifi | **0** / 2.017 |
| Aday olamayan yayındaki ürün (ürün düzeyi koşul) | 583.316 |

Tam tarama ~60 sn sürer; yalnızca tanıdır.

### 8.4 Testler

`freshness-coverage.integration.test.ts` (gerçek Postgres, 11 test): aday penceresi (sınır 5, 8 eski +
3 güncel ürün; teklifsiz ürün aday kalır; politika yokken hiçbir ürün elenmez), JIT'in kapatıldığı,
arama sonucu, TRY `compareMerchants`/`getPriceComparison`/`getSizeOptions`, politikasız Hepsiburada
benzeri besleme (12 gün önceki üyelik de görünür), başarısız/reddedilen çalışmaların teklifsiz gün
sayılmaması, geri dönen teklifin aynı satırda yeniden görünmesi, ürün/kategori/teklif/fiyat geçmişinin
(`price_point`) yerinde kalması. Mutasyonla doğrulandı: aday filtresi, `compareMerchants` koşulu,
`complete` şartı ve `jit` ayarı kaldırıldığında ilgili testler düşüyor.
