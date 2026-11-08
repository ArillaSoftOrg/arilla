# 0177 — Ürün düzeyinde metin embedding altyapısı

Durum: **kabul (T5)**. Migration 0105. Pilot karar 0170'in üretim tablosu ve toplu işi; arama
entegrasyonu (sorgu vektörü, aday birleşimi) bu kararın kapsamında **değildir**.

## Bağlam

- Üretimde `embedding` tablosu boş: `enrich` hiçbir zamanlayıcıya bağlı değil (bilinçli; 0136,
  `docs/ops.md`). `similarity --edges` vektörsüz koşup `success` yazıyordu (0174 bunu
  `blocked_upstream` yaptı).
- 0170 pilotu ürün düzeyinde `jina-embeddings-v3` + halfvec ile metin aramasının boşluklarını
  ölçtü (TR→EN eşleşme, sıfır sonuç) ama kodu `embedding` tablosuna float32 yazıyor, migration
  numaraları üretimde uygulanmış 0104 ile çakışıyor ve değişiklik tespiti tam tarama gerektiriyordu.
- Üretim (8 Kasım, salt okunur): 12,26 M ürün, 99 GB boş disk, pgvector 0.8.1, `product.updated_at`
  indeksi yok, kategori kayıtlarının ~%21'i boş ve sınıflandırma koşuları kategorileri toplu değiştiriyor.

## Karar

1. **Birim ürün, model `jina-embeddings-v3`, görev `retrieval.passage`.** Sorgu aynı modelle
   `retrieval.query`. Teklif/görsel vektörleri (`embedding`, `jina-clip-v2`) aynen kalır.
2. **Ayrı tablo `product_text_embedding`** (0105): `(product_id, model_version)` birincil anahtar,
   gerçek FK + `ON DELETE CASCADE`, `halfvec(768)`, `content_hash`/`source_hash` 16 bayt `bytea`,
   `text_version smallint`. float32 tam katalogda ~102 GB, diske sığmaz; halfvec'te pilotta
   sıralama kaybı ölçülmedi.
3. **Kanonik metin** (`enrich/product_text.py`, `TEXT_VERSION = 1`): marka (başlıkta yoksa ve yer
   tutucu değilse) + başlık. Büyük/küçük harf korunur, NFKC, kontrol karakterleri ve anlam taşımayan
   satış ekleri silinir, 400 karakter sözcük sınırında kesilir. **Kategori metne girmez**:
   sınıflandırma koşusu her seferinde ücretli yeniden embedding tetiklemesin; kategori aramada
   kesin süzgeçtir. `enrich/text.py`'deki `I → ı` dönüşümü İngilizce ağırlıklı katalogda anlamı
   bozduğu için kullanılmaz.
4. **Değişiklik tespiti SQL'de.** `source_hash = md5(title ‖ U+001F ‖ brand.name)` sorguda
   hesaplanıp saklananla karşılaştırılır; tarama birincil anahtar aralığı pencereleriyle
   (varsayılan 20.000 kimlik) ilerler. Değişmeyen ürün Python'a gelmez; `updated_at` indeksi ya da
   tetikleyici gerekmez, yazıcılar (collect, feeds, publish, classify) değişmez.
5. **Gereksiz çağrı yok:** kaynak değişti ama kanonik metin aynıysa yalnız `source_hash` güncellenir;
   aynı `content_hash` başka üründe varsa vektör sunucu tarafında kopyalanır; pencere içindeki
   yinelenen metin tek kez gönderilir.
6. **Bütçe ve güvenlik:** kuru çalışma varsayılan; `--execute` gerçek istemciyle `--max-tokens` ister.
   Dakikalık token bütçesi (0028), 4xx'te partiyi ikiye bölerek tek bozuk girdiyi ayıklama, ardışık
   3 geçici hatada durma, her başarılı çağrının vektör yazımından önce ayrı işlemde `api_usage`'a
   yazılması (kural 9), WAL geri basıncı (0134), SIGTERM'de parti sonunda durma, tek koşu için
   danışma kilidi.
7. **Sonuç sözleşmesi (0174):** `enrich_products` katılır; öncelik `skipped_locked` >
   `provider_errors` > `wal_backpressure` > `interrupted` > `item_errors` > `no_input/up_to_date` >
   `completed` (`token_budget_reached`, `limit_reached`). Kuru çalışma ve sahte istemci iş kaydı
   bırakmaz.
8. **Kimlik kuralı:** embedding benzerliği ürün kimliği kanıtı değildir. Bu iş `resolve`,
   `match_candidate` ve `similarity_edge`'e yazmaz.

## Ölçümler

| ölçü | değer | kaynak |
|---|---|---|
| satır başına disk (yığın + özet indeksi, HNSW hariç) | ~2,2 KB | **ölçüldü**, yerel 20.200 ürün |
| ilk koşu, 20.200 ürün (sahte istemci) | 9,4 sn | **ölçüldü**, yerel |
| değişiklik yokken ikinci koşu | 0,1 sn, 0 çağrı | **ölçüldü**, yerel |
| ürün başına token | 45,5–47,5 | 0170, üretim örneği |
| P1 (20 bin ürün) | ~0,95 M token ≈ $0,05, ~14 dk @ 70 bin TPM | **tahmin** |
| tam katalog (12,26 M) | ~582 M token ≈ $29; ~27 GB + HNSW (~2 KB/ürün, 0170) | **tahmin** |

## İndeks

HNSW bu migration'da yok: yükleme sırasında indeks bakımı yazımı ve WAL'i büyütür. Yükleme
bittikten sonra ayrı `kind: concurrent` migration:
`CREATE INDEX CONCURRENTLY ... USING hnsw (embedding halfvec_cosine_ops) WHERE model_version = 'jina-embeddings-v3'`
(yeterli `maintenance_work_mem` ile; üretimde 512 MB tam katalog için yetersiz, 0170).

## Reddedilen alternatifler

- **`embedding` tablosuna yazmak (pilot):** float32, FK yok, teklif ve ürün yaşam döngüsü karışır.
- **`updated_at` filigranı:** indeks yok; yazıcıların hepsi `updated_at` güncellemiyor; tetikleyici
  her ürün yazımına maliyet ekler.
- **Kategori yolunu metne katmak:** sınıflandırma koşusu başına ~%65 yeniden embedding (tahmin).
- **`search_outbox` tüketicisi:** 0136 kuyruğu bilinçli olarak tüketicisiz; 26,8 M satır birikti.

## Sonraki adımlar (ayrı PR'lar)

1. P1 pilotu: kimlik listesi (yoğun dilim + katmanlı örnek), kuru çalışma, onayla gerçek koşu.
2. HNSW migration'ı (yükleme sonrası) ve filtreli ANN ölçümü.
3. Arama: sorgu vektörü (`retrieval.query`, `api_usage`, önbellek), pilotun `semantic/`
   katmanının bu tabloya taşınması, KVKK süzgeci (`queryContentIneligibility`) bağlanması,
   bayrak kapalı gölge ölçüm, insan etiketli değerlendirme.
4. `similarity` metin kenarlarının ürün vektörüne geçmesi ve eşiklerin v3 için yeniden ayarı.
