# 0164 — Otomatik katalog hattı: yeni teklif → taslak → üst kategori → kapı → yayın

Durum: kabul edildi (31 Ekim 2026; kod ve birimler hazır, **kurulum ayrı ve onaylı**). Üretim
verisine bu kararla dokunulmadı; zamanlayıcı `catalog-auto-timers install --confirm` ile elle kurulur.
**İlişkili:** 0121 (kaynak ilanı kataloğu), 0113/0114 (yurt dışı fiyat), 0134 (WAL geri basıncı),
0145 (günlük besleme), 0160 (yayın tazeliği), 0161 (üst kategori yazımı).

## Bağlam

`catalog_build` (build → gate → publish) ve `classify parents` bilerek elle çalışıyordu. Besleme
günde iki kez yeni teklif getiriyor; ürüne dönüşmeleri ise biri komutu çalıştırana kadar
beklemekteydi. 5,13 M kayıtlı yeni sürümle (31 Ekim) imleçten sonra 3,7 M teklif birikti. Sahibin
hedefi veri biriktirmek değil, **yeni bir AliExpress teklifinin kendiliğinden ManiCepte ürününe
dönüşmesidir**. Eksik olan adımlar değil, onları bağlayan otomasyondur.

## Karar

1. **Yeni komut:** `python -m catalog_build auto --merchant aliexpress --confirm --allow-foreign`.
   Var olan dört adımı sırayla çağırır; hiçbirinin kuralını değiştirmez:
   `build` (imleç), `classify parents` (imleç), `gate` (`--stale-days 2`), `publish` (tazelik yayın
   anında yeniden kontrol edilir, karar 0160). Her adım `job_run.track` altındadır; özet sayaçlar
   `catalog_auto` kaydında, ayrıntı (held nedenleri) adımın kendi kaydındadır.
2. **Tek yazar, üretim senkronizasyonuna öncelik:** `pg_advisory_lock(4133201)`; başka bir
   `catalog_build`/`classify` oturumu, `feeds sync` (4301), `feeds daily` (4302) ya da benzerlik
   kenarı kilidi varsa başlamaz (çıkış 4, hata değil); çalışırken 15 sn'de bir bakılır ve besleme
   başlarsa parti sonunda durur. Yedek penceresi (01:20–02:05 UTC) ve disk eşikleri
   (başlangıç ≥ 70 GB, rezerv 40 GB — `catalog-publish` ile aynı) uygulanır. WAL geri basıncı
   (karar 0134) her adımda geçerlidir (çıkış 3).
3. **Sürelidir ve kaldığı yerden sürer:** `--max-seconds` adımlara pay edilir (build %35, kategori
   %20, kapı %15, yayın %30; kalan sonrakine kayar). Yayın her koşuda `--publish-limit` (varsayılan
   300 bin) ile sınırlıdır; sonraki koşu `ready`'den sürer. Bir adım hata verirse sonrakiler yine
   denenir (bağlantı kopması ve WAL durması hepsini durdurur).
4. **Kategorisiz ürün yayınlanır (varsayılan):** `--require-category` KAPALIDIR. Gerekçe: hat yalnızca
   güvenilir üst kategori yazar (karar 0161); kategorisiz ürün **yanlış** bilgi taşımaz, yalnızca
   kategori sekmesinde/filtresinde görünmez ve metin aramasında bulunur (ölçüm aşağıda). Var olan
   2,77 M yayınlı ürünün çoğu da kategorisizdir; yeni ürünleri onlardan sıkı tutmak tutarsızdır.
   `--require-category` açılırsa kategorisiz ürün `held` (`category_missing`) kalır. **Sahip bu
   varsayılanı değiştirmek isteyebilir** (açık karar).
5. **Yurt dışı (USD) ürünün otomatik yayını sahibin açık kararıdır** (31 Ekim 2026, "uygun ürünleri
   otomatik yayımla"). Karar 0113/0114'ün "yurt dışı fiyatın gösterimi açık karar ister" kapısını bu
   hat için açar: zamanlayıcı birimi `--allow-foreign` ve `CATALOG_PUBLISH_FOREIGN_APPROVED=true`
   verir; birim yalnızca açık onayla kurulur. Siteyi herkese **açmaz**: `PRODUCT_ACCESS` kapısına
   dokunulmaz.
6. **Kapı kapsamı mağaza ile sınırlıdır** (`gate` yeni `merchant_id` parametresi; öncesinde
   `catalog-publish` ve elle çağrı tüm mağazaları kapsıyordu — varsayılan davranış korunur). Hat
   başka mağazanın ürününü `held`'e çekemez. Kapı iki geçiştir: `draft` (hiç değerlendirilmemiş;
   durumsuz) ve `held`/`ready` yeniden bakış (kaynakta geri dönen teklifin ürünü `ready` →
   `published` olur; imleç önceki `catalog_auto` kaydında).
7. **Haftalık tam yeniden tarama (`--rescan-days 7`):** build imleci yalnızca ileri gider; önceden
   kural gereği atlanmış (kötü başlık, pasif) ama sonradan geçerli olan teklifler imlecin gerisinde
   kalırdı. `rescan` imleci sıfırlar, ürünler `ON CONFLICT DO NOTHING` ile tekrar oluşmaz.
8. **Yeni fiyat bandı/besleme için ek iş yoktur:** hat besleme değil **mağaza** düzeyindedir.
   Bantlar aynı `merchant`'a bağlanıp senkronize edildikçe teklifleri imleçten sonra gelir.
9. **Tetik:** `arilla-catalog-auto.service` + `.timer` (`infra/vps/systemd`) ve
   `catalog-auto-timers` (preflight/install --confirm/status/disable). Asıl tetik, besleme günlük
   işi **başarıyla** bitince `OnSuccess=` (yalnızca drop-in; `arilla-feeds-daily.service` dosyası
   değişmez, `disable` drop-in'i siler). Güvenlik ağı: 12:15 ve 21:15 UTC. `ExecCondition`
   (`catalog-auto-guard`) günlük iş, yedek ve gece hattı çalışırken sessizce atlar.
   `TimeoutStartSec=2h30min`, `--max-seconds 8400`.
10. **İzlenebilirlik:** `catalog_build backlog` (YALNIZCA OKUR; işlem `READ ONLY`): bağsız teklif,
    imleçten sonraki teklif, ürün durumları, held nedenleri, kategorili/kategorisiz, en eski bekleyen
    ürün, son koşular. Yönetim paneli iş listesine `catalog_auto` ve `classify_parent` eklendi
    (gecikme eşiği 36 saat).

## Dokunulmayanlar

`offer` fiyat/para birimi/tazelik alanları, `price_point` (INSERT-only), `feed_source.config`
(`no_deactivate`, `freshness`), mevcut yayınlı ürünler, zamanlayıcılar (kurulum elle), alt kategori
yazımı (karar 0157: %56 yanlış; yalnızca inceleme), `lexicon --apply` (kategori filtresi
canlıda açılmadı), `is_discoverable` bayrakları.

## Aramada görünürlük — ölçüm (yerel gerçek PostgreSQL, üretimle aynı kod)

Yayınlanmış (`published`) ürün:

- **Metin araması:** bulunur. Aday kümesi `publication_state = 'published'` ve başlık üçlü-harf
  indeksiyle (`offer_count > 0` / `= 0` bölümleri) oluşur; yurt dışı (USD) ürün ikinci bölümdedir.
  Kategorili ve kategorisiz USD ürünün ikisi de bulundu (kart tutarı kendi para biriminde; kur yoksa
  `current_price` NULL, karar 0132).
- **Kategori sekmesi/filtresi:** yalnızca `category_id` dolu ürünü getirir (`category_path`
  filtresi); kategorisiz ürün görünmez. Doğrulandı.
- **Ürün sayfası:** `resolveProductSlug` yayınlı ürünü bulur; taslak/`held` 404 verir (var olan
  `source-listing.integration.test.ts`, 8/8).
- **`is_discoverable`:** arama ve ürün sayfasını etkilemez; yalnızca keşfet akışı, sitemap ve
  küratör havuzunu süzer. Trendyol'dan gelen yeni üst düğümler `FALSE` ise bu ürünler sitemap/
  keşfette görünmez (SEO), aramada görünür. Bayrağı açmak ayrı bir karardır.
- **Önkoşul — mağaza etkin olmalı:** en iyi teklif seçimi (`bestOfferCte`) `m.is_active` ister.
  `merchant.is_active = false` iken **yayınlı ürün aramada bulunmadı** (ölçüldü). Üretimde
  `aliexpress` mağazasının etkinliği bu çalışmada doğrulanmadı (üretime erişilmedi); hattı kurmadan
  önce okunmalıdır.
- `search_outbox` kayıtlarının tüketicisi yoktur (karar 0136); arama doğrudan `product`/`offer`
  tablolarından okur, indeks gecikmesi yoktur.

## Reddedilen alternatifler

- **Yeni iş kuyruğu/servis veya katalog mimarisi:** var olan adımlar yeterli; ek bağımlılık yok.
- **Gate'i besleme koşusunun içine gömmek (`feeds daily` sonunda):** besleme süre bütçesini
  (6 sa) yer ve yayın hatasını besleme hatası gibi gösterirdi. Ayrı birim, `OnSuccess` ile zincirli.
- **`--require-category` varsayılan açık:** yeni ürünlerin yaklaşık üçte birini aramadan saklardı;
  mevcut ürünlerle tutarsız (madde 4).
- **Her koşuda tam yeniden tarama:** 4–6 M teklif okur; haftalık yeterli.
- **Zamanlayıcıyı otomatik kurmak:** ürün yayınlayan hat açık onayla kurulur.

## Riskler

- Yayın hızı: yaklaşık 300 bin ürün/koşu; 3,7 M birikim ~12 koşu (≈ 6 gün). Hızlandırmak için
  `--publish-limit` ve zamanlayıcı sıklığı artırılabilir (WAL ≈ 8,5 KB/ürün, karar 0135).
- Besleme günlük işi uzar ya da sık `partial` biterse yalnızca güvenlik ağı tetiği çalışır.
- Kategori eşlemesi %81,8 doğrudur (AI etiketli, iyimser, karar 0157); yazım geri alınabilir.
- `catalog_auto` yalnızca `ready` ürünleri yayınlar; kapı ile yayın arasında kaynak değişirse
  yayın anındaki yeniden kontrol (karar 0160) `held` yapar.
