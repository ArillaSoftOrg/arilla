# Admitad feed intake kontrol listesi

Amaç: gerçek bir feed geldiğinde **ilk istenecek bilgiler** ve 1.000 satırlık
örnekten çıkarılacak istatistikler. Hiçbir alan adı tahmin edilmez (karar 0012);
bu liste *soru* listesidir, şema değil. Kaynak biçimi bilinince yalnız
`feed_config.mapping` (veri) ve gerekirse bir taşıma katmanı yazılır
(`docs/catalog-120m-audit.md` §12: Taşıma → `RawRecord` → Eşleme → `NormalizedOffer`).

## 0. Mevcut altyapıda ZATEN olan (soruları buna göre oku)

Güncel `main` + `feature/shopify-canonical-domains` (`2403ab4`) gerçekliği; eski problemler
olarak ele alınmaz:

* **Chunk'lı, checkpoint'li, devam edilebilir toplama:** chunk başına commit, `ingest_run.checkpoint`,
  `partial/resumable`, merchant başına advisory lock, aynı koşuyu yeniden deneme idempotent.
  Devam bugün **kimlikle** yapılır (kaynak baştan akıtılır, bu koşuda yazılanlar atlanır); satır
  sırası kararsız olsa da doğru çalışır ama **kaynağı yeniden indirir**. Çok büyük dosya için
  ofset/staging gerekir (audit B3/B6) — bu yüzden "satır sırası ve dosya boyutu" soruları önemli.
* **`price_point` değişim olayıdır**, tazelik `offer.last_seen_at`'tir. "Fiyat/stok değişim oranı"
  sorusu bu yüzden yazma hacmini belirler (satır yazımı hâlâ her koşuda tam; yalnız geçmiş değişimde).
* **`full_dump` pasifleştirme:** `last_seen_at < observed_at` ile; "tam dump mu?" sorusunun cevabı
  `feed_config.full_dump`'u belirler. Eksik-feed oran/bütünlük kapısı **yok** (audit B4).
* **Çözümleyici toplu:** ≈54 offer/sn (üretim ölçümü). GTIN/MPN doluluğu aday üretiminin
  maliyetini ve otomatik eşleşme oranını belirler; aday üretimi hâlâ tam-katalog trigram/ANN.
* **Hâlâ yok (feed gelince karar):** akışlı indirme (`xml_feed` dosyayı belleğe alır), R2 staging,
  dead-letter, parmak izi ile atlama, skaler kimlik kolonları, `product_identity`.

## 1. Gelen bilgiye göre ilk sorular

| # | Soru | Neden / neyi belirler |
| --- | --- | --- |
| 1 | **Tam dump mu, delta mı?** (ikisi de var mı) | `feed_config.full_dump`; pasifleştirme yalnız tam dump'ta güvenli |
| 2 | **Biçim/protokol:** XML / CSV / JSON / API; HTTP(S) / SFTP; kodlama; sıkıştırma (gzip/zip); tek dosya mı parça mı | Taşıma katmanı, akış, R2 staging |
| 3 | **Satır sayısı ve dosya boyutu** (ham + sıkıştırılmış); merchant başına dağılım | Parça boyu, süre bütçesi, R2 maliyeti |
| 4 | **Kararlı kaynak kimliği:** her satırda var mı, zaman içinde değişmez mi, merchant içinde tekil mi | `(merchant_id, external_id)` idempotentliği (kural 7) |
| 5 | **Merchant kimliği:** feed tek merchant mı, çok merchant mı; program/mağaza kimliği alanı | `merchant` eşlemesi, izolasyon |
| 6 | **GTIN/EAN:** alan var mı, doluluk oranı, biçim (8/12/13/14 hane, kontrol basamağı geçerli mi) | Kesin eşleştirme (en güçlü sinyal) |
| 7 | **MPN / SKU / model:** alanlar, doluluk | Marka+MPN bloklaması; SKU yalnız merchant içi |
| 8 | **Marka:** alan var mı; serbest metin mi kodlu mu; boşsa başlıktan çıkarılabilir mi | `brand`, eşleştirme |
| 9 | **Kategori:** merchant kategori ağacı mı yolu mu; derinlik; bizim taksonomiyle eşlenebilirlik | `category_raw` → `category` (kural: kategori yoktan açılmaz, 0017) |
| 10 | **Varyant/grup ilişkisi:** her renk/beden ayrı satır mı; `group_id`/ana ürün alanı var mı | `offer_variant` modeli (0005): satır = offer mı varyant mı |
| 11 | **Fiyat, para birimi, eski fiyat:** alanlar; ondalık/binlik ayracı; vergi dahil mi; para birimi alanı ve TRY dışı oranı; indirimli/eski fiyat | Kuruş tamsayı (CLAUDE.md), 0031 para birimi kapısı, sahte indirim tespiti |
| 12 | **Stok:** bool / adet / metin ("stokta", "in stock"); stoksuz ürün feed'de duruyor mu | `in_stock`, varyant stok olayları |
| 13 | **Deeplink / affiliate URL:** alan; takip parametresi; ürün sayfası URL'sinden ayrı mı; yönlendirme zinciri | Kural 8: her dış çıkış `click` kaydı üretir |
| 14 | **Görsel URL'leri:** kaç alan; çözünürlük; URL kararlı mı; hotlink/önbellek izni | Tembel mirror, `image_url`; 120M görsel baştan indirilmez |
| 15 | **Güncelleme/silme sinyali:** `updated_at` var mı; silinen ürün feed'den mi düşer, işaretle mi gelir; delta'da silme nasıl | `last_seen_at`/pasifleştirme; sanity kapısı |
| 16 | **İki snapshot arası değişim oranı** (örn. ardışık iki günlük dosya) | Fiyat/stok/içerik değişim oranı → yazma yükü, parmak izi kararı |
| 17 | **Hukuki/ticari:** veri ve görsel yeniden yayın izni, önbellek/mirror izni, hız sınırı, kullanım koşulları, komisyon alanı | Mirror kapsamı, robots/ToS (0042 yaklaşımı) |
| 18 | **Örnek erişimi:** kimlik bilgisi/süresi, güncelleme sıklığı, ETag/Last-Modified desteği | Koşul GET, hash ile atlama |

## 2. 1.000 satırlık örnekten çıkarılacak istatistikler

Her metrik için hedef: hangi karara girdi olduğu. Örnek rastgele değil **dosyanın
başından ve ortasından** alınmışsa söyle (sıra yanlılığı).

**Yapı ve kimlik**

* Satır/benzersiz kimlik sayısı; **tekrarlı kimlik oranı**; kimlik biçimi (uzunluk, karakter kümesi); boş/eksik alan matrisi (alan × doluluk %).
* Merchant/program sayısı ve en büyük merchant'ın payı.
* Varyant yapısı: `group_id` var mı; grup başına satır sayısı (min/medyan/p95/max); grup içinde değişen alanlar (renk? beden? yalnız fiyat?).

**Tanımlayıcılar (eşleştirme gücü)**

* GTIN doluluk %; **geçerli GS1 kontrol basamağı %**; GTIN başına satır sayısı (aynı GTIN'in kaç satırda göründüğü → merchant içi/arası örtüşme).
* MPN / SKU doluluk %; marka doluluk %; **marka+MPN çiftinin benzersizlik oranı**.
* Marka değeri çeşitliliği (benzersiz marka sayısı, yazım varyantları: "Nike"/"NIKE"/"nike ").

**Fiyat ve stok**

* Fiyat biçimi örnekleri (ayraç, sembol); sayıya çevrilemeyen satır %; sıfır/negatif/uç fiyat %; **para birimi dağılımı** (TRY dışı %).
* Eski fiyat doluluğu; eski fiyat > fiyat oranı; indirim yüzdesi dağılımı (p50/p95).
* Stok değeri dağılımı (kodlar); stoksuz satır %.

**İçerik ve görsel**

* Başlık uzunluğu (p50/p95/max); açıklama uzunluğu (R2'ye taşınacak mı); kategori alanı: benzersiz değer sayısı, derinlik, **bizim taksonomiye otomatik eşlenebilen %**.
* Görsel alanı doluluğu; satır başına görsel sayısı; **URL erişilebilirlik örneği** (50 URL'ye HEAD/GET, durum kodu dağılımı, boyut); aynı görselin birden çok satırda tekrarı.
* Deeplink doluluğu; URL'de takip parametresi deseni; alan adı çeşitliliği.

**Hacim ve zamansallık (iki dosya varsa)**

* İki snapshot arasında: yeni / kaybolan / **fiyat değişen / stok değişen / içerik değişen** satır % (modeldeki %4 ve %0,5 varsayımlarını doğrular).
* Satır sırasının kararlılığı (aynı kimlik aynı sırada mı → ofset tabanlı devam mümkün mü).
* Tam dosya: ham/gzip boyut, satır başına bayt, ayrıştırma hızı (1 çekirdek, satır/sn).

## 3. Çıktının karara dönüşmesi

| Bulgu | Karar |
| --- | --- |
| GTIN geçerli doluluk yüksek (≳ %60) | GTIN-öncelikli blok; çözümleyici yükü düşük |
| GTIN düşük, marka+MPN yüksek | marka+MPN bloğu; `mpn_norm` skaler kolon |
| İkisi de düşük | başlık+marka blok içi benzerlik; kanonikleştirme oranı düşük (r → 1) → ürün ve arama dokümanı sayısı yüksek |
| Satır = varyant (grup alanı var) | `offer` gruplama/varyant eşlemesi; offer sayısı satır sayısından az |
| Satır = offer (grup yok) | varyant yok ya da beden alanı serbest metinden |
| İçerik değişimi çok düşük, fiyat/stok %3–5 | değişim algılama (parmak izi) değer üretir: bugünkü yazıcı her koşuda tüm offer/varyant satırını yeniden yazıyor (`price_point` ise yalnız değişimde). Karar yalnızca ~3–5M offer üstünde zorunlu; önce tazelik sözleşmesi (`last_seen_at`) ADR'si |
| Delta feed var | "silme" sinyali tanımlı mı → pasifleştirme güvenli yol |
| Görsel URL ayakta kalma düşük | mirror öncelikli (popüler ürünlerde); aksi hâlde tembel |
| Para birimi karışık | kayıt düzeyi kapı (0031) eşlemesi |
| Satır sırası kararsız | bugünkü kimlikle devam zaten doğru (kaynak baştan akıtılır); büyük dosyada R2 staging + ofset ile indirmeyi tekrarlamamak |

Bu bilgiler gelmeden **şema kilitlenmez**; `product_identity`, parmak izi kolonları,
skaler tanımlayıcılar ve R2 staging düzeni örnekten sonra kararlaştırılır (audit B10–B12).
