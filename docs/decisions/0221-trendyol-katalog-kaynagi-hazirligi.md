# 0221 — Trendyol'u ikinci katalog kaynağı olarak açılmaya hazırlama

**Tarih:** 26 Kasım 2026
**Durum:** Kabul edildi. §A (hazırlık) migration'sız; §B (zamanlama) migration 0119. Toplama **kapalı kalır**: `collection_source.enabled = FALSE`
(0079) ve `TRENDYOL_COLLECTION_ENABLED` ortam bayrağı değişmedi. Açmak kullanıcı kararıdır.
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

## B. Zamanlanmış toplama (0118'i değiştirir)

0118 "otomatik sekme gezintisi"ni, izin kapsamı teyit edilmediği için reddetmişti. Ürün sahibi
toplamanın takvimle, kendiliğinden çalışmasını istedi (26 Kasım 2026). 0118'in değişmeyen
çekirdeği korunarak izin verilir:

1. **Yalnız yöneticinin kendi tarayıcısında.** Eklentiye arka plan zamanlayıcısı eklenir
   (`scheduler.js`, izin: `storage` + `alarms`; `tabs` izni YOK, `host_permissions` YOK). Saatlik
   alarmda, sayfanın bıraktığı "sonraki yoklama" zamanı gelmişse sabit yönetim adresini
   (`/yonetim/katalog/toplama/trendyol?otomatik=1`) arka plan sekmesinde açar. Sunucu ve VPS
   Trendyol'a istek atmaz; headless tarayıcı, proxy, çerez/oturum taklidi, bot koruması aşma yok.
   Eklentinin derlenmiş paketinde ağ API'si yoktur (`audit.mjs`).
2. **Karar sunucuda, kota veritabanında.** Sayfa `POST /api/yonetim/katalog-toplama/zamanlama`
   (`status`) ile sorar. Kota (`getCollectionStatus` + 0070/0075 tetikleyicisi: en az 7 gün,
   takvim ayında 4, ilk yükleme dahil) izin verirse `start` zamanlanmış koşuyu açar
   (`collection_run.options.trigger = "scheduled"`). Tetikleyici yine son karardır.
3. **Nazik hız, tek sekme.** Sayfa kayıtlı hedef adresleri (`collection_schedule.target_urls`,
   ≤ 500, yalnız ürün/liste adresi) eklentiye birer birer actırır; iki açılış arası en az
   `pace_seconds` (20–600, varsayılan 45) + %0–50 rastgele. Sayfayı yine içerik betiği okur,
   aktarım 0118 ile aynıdır (koşu başına 500 sayfa bütçesi, yapı yoksa durur, yeniden deneme yok).
4. **Taze giriş:** zamanlamayı değiştirmek (`save`) taze giriş ister; zamanlanmış koşuyu açmak
   istemez (hedefler ve kota sunucuda, istemci parametre veremez). Yönetim oturumu süresi aynen
   geçerlidir; oturum düştüyse koşu açılmaz ve gecikme bulgusu oluşur.
5. **Kayıt ve görünürlük.** `collection_schedule` son denemeyi, koşuyu, sonucu (`completed`,
   `budget`, `blocked`, `interrupted`, `start_refused`, `error`, `aborted`) ve hata kodunu tutar.
   Yönetim sayfası durum, sonraki yoklama, son sonuç ve ayarı gösterir. Bulgular
   (`collection-schedule-findings.ts`): son koşu başarısız (14 gün içinde) ve kota izin verdiği
   halde koşu 2 günden fazla gecikti. Yarıda kalan koşu (`interrupted`) sonraki açılışta aborted
   kapatılır; yalnız eksiksiz koşu `completed` kapanır (0140 kaldırılma hesabı yarım taramayı saymaz).
6. **Üç yerden kapalı gelir:** `collection_source.enabled = FALSE`, `TRENDYOL_COLLECTION_ENABLED`,
   `TRENDYOL_SCHEDULE_ENABLED`; ayrıca `collection_schedule.enabled = FALSE` (satır yok).

Risk notu: izin belgeleri hâlâ incelenmedi (0118). Otomatik açılış, yöneticinin elle açacağı
sayfalarla aynı hacim ve kota içinde kalır; ama "toplu tarama" sayılıp sayılmadığı belgelerle
teyit edilmelidir. Bu yüzden zamanlayıcıyı açmak ayrı bir kullanıcı kararıdır.

Reddedilen: sunucu/VPS'ten zamanlanmış çekme, headless tarayıcı (0118: bot korumasını aşmak);
eklentiye `tabs`/`host_permissions` verip sekme içeriği okumak (gereksiz yetki); eklentinin
sunucuya doğrudan istek atması (ağ API'si ve çerez erişimi gerekirdi; aktarım sayfa üzerinden kalır).

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
