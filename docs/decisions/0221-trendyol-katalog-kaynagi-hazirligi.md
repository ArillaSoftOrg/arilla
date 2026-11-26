# 0221 — Trendyol'u ikinci katalog kaynağı olarak açılmaya hazırlama

**Tarih:** 26 Kasım 2026
**Durum:** Kabul edildi. §A (#384) migration'sız; §B migration 0119 (ortak zamanlayıcı, haftalık kota). Toplama **kapalı kalır**: `collection_source.enabled = FALSE`
(0079) ve `TRENDYOL_COLLECTION_ENABLED` ortam bayrağı değişmedi; zamanlayıcı `CATALOG_AUTO_COLLECT_ENABLED` ile kapalı. Açmak kullanıcı kararıdır.
**İlişkili:** 0118 (Trendyol yönetici toplaması), 0130 (kaynak ilanı hattı, `listing_only`),
0164 (kaynak kayıt defteri), 0117 (toplama altyapısı), 0036 (barkod GS1 kontrolü).

## Bağlam

Çapraz mağaza eşleştirmesinin girdisi yok: üretimde Trendyol teklifi 0. Toplama kodu (0118) hazırdı
ama kaynak kayıt defteri (`services/ingest/platforms/registry.py`) 0118 ile çelişiyordu:

1. Trendyol `listing_seller` (anahtar `<contentId>~<satıcı>`) ve `is_marketplace=True` idi. 0118 §5:
   teklif **ürün başınadır**, `external_id` = contentId, kazanan satıcı değişince `seller_id`
   güncellenir. Toplayıcı zaten yalnız contentId yazıyordu.
2. `status="sample"` ve `listing_only` değildi. `listing_only_slugs()` yalnız `verified` kayıtlara
   baktığı için Trendyol cozumleyicinin (`python -m resolve`) dışlama listesinde **yoktu**: toplama
   açılsaydı Trendyol teklifleri kalite kapısını atlayarak doğrudan yayınlanmış ürün açabilir ya da
   başlık/görsel benzerliğiyle başka ürüne bağlanabilirdi (0130'un HB/AliExpress için kapattığı yol).
3. Ürün sayfasındaki kazanan varyantın barkodu okunmuyordu; HB ile eşleştirmenin en güçlü kanıtı yoktu.

## Karar

1. **Kayıt 0118 §5'e hizalanır.** `TRENDYOL`: `offer_key_scheme="listing"`, `is_marketplace=False`
   (Hepsiburada gibi: yalnız kazanan satıcı okunur, satıcı başına teklif yok), `listing_only=True`,
   `kind="json"`, `min_refresh_interval=7 gün`. Kimlik kuralı: `external_id` `^[0-9]{1,20}$`,
   kanonik adres `https://www.trendyol.com/<marka>/<slug>-p-<contentId>` (toplayıcının
   `trendyolCanonical` kuralıyla aynı; sorgu/parça yok).
2. **`verified`'a yükseltme gerekçesi.** Kimlik kuralı depodaki kayıtlı GERÇEK örneklerle sınanır
   (`packages/core/src/catalog-collection/fixtures`: iPhone 16 Pro ve Samba ürün sayfaları, liste
   kartları — tek normal ziyaretle okunan alanlar): adresteki `-p-<id>` = gömülü `product.id` =
   JSON-LD `@id`; liste kartının kanonik adresi `contentId`'yi taşır. Test:
   `services/ingest/tests/test_trendyol_identity.py`. Örnek sayısı küçüktür; ilk gerçek koşudan
   sonra kapı atlama nedenleri (`source_id_url_mismatch`) izlenmelidir (aşağıda).
3. **Çözümleyici dışlaması durumdan bağımsızdır (fail-closed).** `listing_only_slugs()` artık tüm
   kayıtlara bakar; `SOURCE_LISTING_MERCHANTS` kimlik kuralı olmasa da `listing_only` kaynağı
   dışlar. Doğrulanmamış bir kaynak ürün açamaz (kapıya da giremez); kapıyı atlayan yol kalmaz.
4. **Barkod ve marka.** 0118 kapsam tablosuna eklenir: ürün sayfasında
   `merchantListing.winnerVariant.barcode` (fiyatın ait olduğu varyantın barkodu), yalnız GS1
   kontrol basamağı doğruysa (`trendyolGtin`) `gtin` olarak taşınır. Diğer bedenlerin barkodları
   okunmaz. Liste kartı barkod taşımaz; uydurulmaz. Marka zaten okunuyordu (`brand.name`).
   Birleştirme `attributes_raw.gtin` (GTIN-14) ve `brand_raw` yazar. Ek ağ isteği yoktur; değer açık
   sayfada zaten bulunur.
5. **Yönetim görünürlüğü.** Menüde "Trendyol toplama" bağlantısı; yalnız
   `TRENDYOL_COLLECTION_ENABLED` açıkken görünür (sayfa bayraksız 404 kalır).

## B. Ortak zamanlayıcı ve yeni izin beyanı (26 Kasım 2026; migration 0119)

**İzin kaydı (kullanıcı beyanı, belgeler İNCELENMEDİ):** Hepsiburada ve Trendyol yönetici
tarayıcısı toplaması haftada en fazla 100, takvim ayında en fazla 400 koşuya kadar izinli.
`written_agreement` kullanılmaz; Trendyol politikası sahip rolle `declared_extended` + not,
`min_interval_days = 0`, `max_runs_per_month = 400` olarak güncellenir (kullanıcı yapar; migration
Trendyol politikasını değiştirmez).

1. **Tek zamanlayıcı** (`packages/core/src/catalog-collection/schedule.ts`, 0220'nin modülü):
   Hepsiburada ve Trendyol için ortak; bayrak `CATALOG_AUTO_COLLECT_ENABLED`. Koda gömülü "7 gün /
   ayda 4" kaldırıldı. Karar `getCollectionStatus`'tan gelir: `min_interval_days`,
   `max_runs_per_month`, `max_runs_per_week`, hacim kotası, açık koşu. Tetikleyici son sözü söyler.
2. **Haftalık tavan (0119):** `collection_source.max_runs_per_week` (NULL = uygulanmaz); kota
   tetikleyicisi kayan 7 günde koşu sayısını denetler (`collection_quota_week`). Migration HB ve
   Trendyol için 100 yazar (yalnız NULL ise), HB'nin aylık sınırını (0075'ten beri NULL) 400 yapar.
   `getCollectionStatus` sayımları SQL'de yapar (son 12 koşu ayda 400'ü sayamaz).
3. **Şablon:** zamanlanmış koşu yeni parametre almaz. Hepsiburada: son kapanmış arama koşusunun
   sorguları (0220). Trendyol: son kapanmış koşuda okunan ürün sayfalarının kayıtlı kanonik
   adresleri + liste yolları (`/sr` araması sorgu saklanmadığı için atlanır), en çok 500.
4. **Yalnız yöneticinin tarayıcısında, sayfa açıkken.** Trendyol toplama sayfası açık ve görünürken
   10 dakikada bir sunucuya sorar; izin varsa adresleri eklentiye birer birer, en az 30 sn +
   %0–50 rastgele arayla açtırır. Eklentiye arka plan betiği eklenir (yalnız
   `tabs.create/update/remove`; yeni izin YOK — `alarms`, `tabs`, `host_permissions` yok; ağ API'si
   yok, `audit.mjs` zorlar), çünkü içerik betiği sekme açamaz ve sayfa kullanıcı hareketi olmadan
   pencere açamaz. Sunucu/VPS Trendyol'a istek atmaz; engelde durur, yeniden denemez; yalnız
   eksiksiz koşu `completed` kapanır (0140).
5. **Tazelik:** Trendyol `max_price_age` 8 gün (HB ile aynı; `MAX_PRICE_AGE_DAYS`). Haftalık ya da
   daha sık toplanan teklif 0160'ın 2 günlük eşiğiyle kapıda bayat sayılmaz. Bulgu
   `collection.trendyol.freshness` (HB'ninkiyle aynı kural).

Bu, 0118'in reddettiği "otomatik sekme gezintisi"ni kullanıcı beyanıyla açar; izin belgeleri hâlâ
incelenmediği için bayrağı açmak ayrı bir kullanıcı kararıdır.

## Sınırlar / ayrı işler

- **Çapraz mağaza eşleştirmesi yine yok.** HB ve Trendyol `listing_only` kaynaklardır; her ilan
  kendi taslak ürününü açar. İki kaynağın aynı barkodlu ürününü tek kanonik ürüne bağlayan yazıcı
  (`product_identity`/`match_candidate` yazıcısı) yoktur; bu karar ona girdi hazırlar, kendisi değildir.
- Yayın tazeliği (0160) 2 gündür: haftalık toplamada `collect-merge` sonrası `catalog_build auto`
  2 gün içinde çalışmalıdır; yoksa yeni ürünler `held/stale_source_offer` kalır (yayındakiler
  gizlenmez).
- Bildirilen yazılı izin belgeleri hâlâ incelenmedi (0118); barkodun kapsamda olup olmadığı da bu
  incelemeye dahildir.

## Reddedilen alternatifler

| Alternatif | Neden değil |
|---|---|
| `sample` kalıp yalnız `listing_only` yapmak | `catalog_definitions()` örnek kaydı döndürmez: Trendyol teklifi hiçbir hattan ürün olamaz, eşleştirmeye girdi oluşmaz |
| Trendyol'u `listing_seller` bırakıp toplayıcıyı satıcı anahtarına çevirmek | 0118 §5 reddetti: kazanan satıcı değişince ürün çoğalır, eski teklif aktif kalır |
| Barkodu tüm bedenlerden toplamak | Diğer bedenler başka satıcıya ait olabilir (0118 §3); fiyatla aynı varyant ilkesi |
| Barkodu kontrol basamağısız almak | 0036: yalnız GS1 geçerli barkod kimlik kanıtıdır |
