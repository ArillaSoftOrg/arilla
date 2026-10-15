# 0111 — Katalog ve besleme modeli, kimlik kuralları, migration güvenliği

**Tarih:** 14 Ekim 2026
**Durum:** Kabul edildi. Bu karar şemayı ve kuralları getirir. Besleme keşfi ve
artımlı senkronizasyon (ikinci PR), fiyat doğrulama ve yönetim görünümü (üçüncü PR)
bu modelin üzerine kurulur.

## Bağlam

- Katalog Shopify bootstrap'ıyla büyüdü (`merchant` → `offer` → `offer_variant`,
  `product` renk düzeyinde kanonik; karar 0005). AliExpress (Admitad) gibi
  pazaryerleri için eksikler:
  - pazaryeri satıcısı;
  - satıcılar arası ortak varyant;
  - besleme kaynağı, sürüm ve imleç;
  - parça düzeyi kontrol noktası, hata kaydı;
  - kimlik düzeyi kuralları.
- Mevcut tablolar ve çalışan sistemler korunmalı (V4.1). Şema değişikliği yalnızca
  ekleme olmalı.
- CI migration'ları boş veritabanına uyguluyordu. Ama dolu veritabanında yükseltmeyi,
  `db:verify`'yi ve Python entegrasyon testlerini koşmuyordu.

## Karar

1. **Migration 0065, yalnızca ekleme.** Yeni tablolar:
   - `seller`, `canonical_variant`;
   - `feed_source`, `source_snapshot`, `ingest_chunk`, `ingest_error`;
   - `product_identity`, `identity_observation`, `match_decision_log`;
   - `category_source_map`, `search_outbox`.

   `offer`, `offer_variant` ve `ingest_run`'a eklenen kolonların hepsi NULL olabilir
   ya da sabit varsayılanlıdır; tablo yeniden yazılmaz. Eski kod yeni şemayla
   aynen çalışır.

2. **Kaynak kimlikleri ad alanlıdır:**
   - `(merchant_id, external_id)`: offer, seller;
   - `(offer_id, external_id)`: SKU;
   - `(network, external_id)`: besleme.

   AliExpress için:
   - merchant tek satırdır (AliExpress);
   - seller = mağaza kimliği;
   - offer = AliExpress ürün kimliği;
   - offer_variant = SKU kimliği.

   Admitad satır kimliği kimlik olarak kullanılmaz. Gerçek alan adları besleme
   şeması doğrulanınca yapılandırmaya yazılır; kod alan adı varsaymaz (karar 0012).

3. **Kimlik düzeyi** (`resolve/identity_policy.py`, veritabanı kısıtlarıyla):

   | Tanımlayıcı | Neyi tanımlar | Kısıt |
   | --- | --- | --- |
   | GTIN | Kanonik varyantı | Kontrol basamağı doğru, 14 haneye tamamlanır. Aktif değer tek. Kısıtlı GS1 önekleri kimlik değildir (mağaza içi, kupon, ISBN/ISSN, değişken ölçü). Paket göstergesi 1–8 ayrı varyanttır |
   | Marka + MPN | Ürünü | Marka zorunlu. `(brand_id, değer)` aktif tek |
   | Model ipucu | Yalnız aday üretimi | Benzersiz değil, otomatik birleştirmez |

4. **Doğrulanmamış ürün otomatik birleştirilmez.**
   - Otomatik bağ yalnız aktif ve çelişkisiz bir kesin kimlikle kurulur.
   - Marka, kategori kökü ya da varyant ekseni uyuşmazsa karar `hold` olur ve kimlik
     `conflict` işaretlenir.
   - Kesin kimlik yoksa karar `unmatched` olur. Mevcut puanlı çözümleyici ve inceleme
     kuyruğu değişmez.
   - Her bağlama/ayırma kararı `match_decision_log`'a (append-only) yazılır. Yanlış
     birleştirme yeni bir `unlink` satırıyla geri alınır.

5. **Besleme güvenliği şemada:**
   - Keşfedilen besleme `discovered` olarak kaydedilir. Merchant'a bağlanmadan
     `active` olamaz (CHECK).
   - Kimlik bilgisi (token, imzalı URL) veritabanına yazılmaz; indirme adresi
     senkronizasyonda ağ API'sinden yeniden çözülür.
   - Aynı içerik (sha256) en son tam sürümle aynıysa yeni sürüm `duplicate` olur ve işlenmez.
   - Deaktivasyon silme değildir: `is_active=false`, `deactivated_at` ve nedeni
     yazılır.

6. **Migration güvenliği:**
   - `db:lint-migrations`:
     - numara tekrarı;
     - `price_point`'u değiştiren SQL;
     - `CONCURRENTLY`;
     - 0065'ten itibaren `-- kind:` başlığı zorunlu;
     - açık gerekçe olmadan yıkıcı DDL;
     - `BEGIN`/`COMMIT`;
     - veri migration'ında `RAISE EXCEPTION`.
   - Çalıştırıcı:
     - advisory lock ile tek çalışır;
     - dosya başına `lock_timeout=5s` ve `statement_timeout=15min` uygular.
   - CI `migrations-ingest` işi sırayla:
     - main şeması ve tohum veri;
     - dalın yeni migration'ları;
     - ikinci koşunun boş geçmesi;
     - `db:verify`;
     - Python entegrasyon testleri.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Tek `UNIQUE(kind, value)` kimlik tablosu | GTIN varyantı, MPN modeli tanımlar; tek kural renk/kapasite farkını birleştirir |
| `offer`'ı satıcıya göre yeniden tasarlamak / yeni `source_product` tablosu | Mevcut yazıcı, çözümleyici, görsel ve fiyat geçmişi `offer`'a bağlı. Aynı kavramı iki tabloda tutmak kayma yaratır |
| Besleme URL'sini (token'lı) `feed_source`'ta saklamak | Veritabanı yedeği ve yönetim ekranı sırrı taşır |
| Yeni besleme bulununca otomatik etkinleştirmek | Para birimi, pazar ve lisans doğrulanmadan katalog kirlenir |
| Migration'larda `CREATE INDEX CONCURRENTLY` | Çalıştırıcı her dosyayı işlemde yürütür. Büyük tablo gelince ayrı "çevrimiçi" migration türü ayrı kararla eklenir |

## Sonuçlar

- `lock_timeout=5s` üretim dağıtımında uzun bir işlem tablo kilidini tutarsa
  migration'ı düşürür. Dağıtım geri alınır, yeniden denenir. Kuyrukta bekleyen
  kilit yüzünden sitenin donmasından iyidir.
- Yeni tabloları henüz hiçbir kod yazmıyor. Besleme hattı ikinci PR'da.
- `search_outbox`'ın tüketicisi yok. Arama PostgreSQL'de ve indeks kendiliğinden
  güncel; harici arama motoru gelince tüketici eklenir.
