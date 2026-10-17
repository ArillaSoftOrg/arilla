# 0117 — Hepsiburada: yönetici tarayıcısından katalog toplama

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi (migration 0070; 0068/0069 `main`'de). Kod ve testler hazır. Kaynak `collection_source.enabled = FALSE`
gelir; zamanlayıcı yoktur. Gerçek toplama ayrıca onay ister.
**Bağlam:** Arşiv `research/hepsiburada-archive` (f9d5a47). Canlı tarayıcı araması
önerisini (ziyaretçi tarayıcısından Hepsiburada'ya istek) **iptal eder**.

## İzin kaydı (kullanıcı beyanı)

Aşağıdaki kapsam, ürün sahibinin **Hepsiburada ile yaptığı yazışmadan bildirdiği**
izindir: önce sözlü, sonra e-posta ile yazılı bildirim. Yazışmalar özel ticari belgedir;
depoya konmaz, bağımsız incelenmemiştir ve bu karar onları doğrulanmış gibi göstermez.
İmzalı sözleşme şartı koşulmaz. `collection_source.permission_basis`:
`verbal_reported` → `written_email_reported` (varsayılan kayıt) → gerekirse
`declared_extended` (notlu, kullanıcı beyanı) ya da `written_agreement`.

Bildirilen kapsam:
- Yönetici tarayıcısından veri erişimi (mevcut CORS yöntemi).
- Ürün verisinin PostgreSQL'de saklanması.
- **Haftada en fazla 1, takvim ayında en fazla 4 katalog yenilemesi** (fiyat, yeni ürün,
  kaldırılan ürün).
- Sürekli toplu çekme yoktur. **İlk yükleme için ayrı bir kapsam bildirilmemiştir**:
  ilk yükleme kotadan muaf DEĞİLDİR. Ayrı kapsam bildirilirse yapılandırılabilir:
  `initial_load_exempt` yalnızca `declared_extended`/`written_agreement` dayanağı ve
  açıklama notuyla açılabilir (CHECK); bildirilen kapsamdayken (`verbal_reported`,
  `written_email_reported`) aralık/ay tavanı da gevşetilemez. Kapsamı doğrulanmamış hiçbir
  işlem otomatik yetkilendirilmez; her değişiklik sahip rol/migration ister.

Hedef dışı: diğer satıcıların teklifleri ve stok takibi. Yalnızca ana satıcı, ürün adı,
TRY fiyat, görsel, bağlantı ve varsa varyant etiketi işlenir.

Doğrulanmamış: kullanım koşulları metni, görsellerin yeniden kullanımı, ticari gösterim.

## Karar

1. **Toplama yalnızca yöneticinin kendi tarayıcısında** (`/yonetim/katalog/toplama`,
   `catalog.write`) yapılır. Kullanıcılar Hepsiburada'ya istek göndermez; kullanıcı
   aramaları mevcut PostgreSQL kataloğundan (`offer` → arama) karşılanır. Sunucu
   Hepsiburada'ya erişmez (Akamai 403 bilinen durum; aşılmaya çalışılmaz).
2. **Çıkarıcı arşivdeki yöntemdir:** `/ara?q=` (+`&sayfa=N`) sayfası,
   `reduxStore` → `ProductList.seoState.itemListElement`
   (`packages/core/src/catalog-collection/extract-hepsiburada.ts`). Çerezsiz,
   `mode: "cors"`.
3. **Aktarım kimlikli API ile:** `POST /api/yonetim/katalog-toplama`. Oturum çerezi +
   `catalog.write` + yönetim oturumu süresi + aynı-kökenli istek; kosu başlatmak taze
   giriş ister; yetkisizlere 404. Gövde 1,5 MB, parti 500 kayıt. Sunucu her alanı yeniden
   doğrular (`validate.ts`): `hepsiburada.com`/`hepsiburada.net` alan adı, https, TRY,
   tam sayı kuruş, kaynak zamanı koşu aralığında. Gizli bilgi istemciye gitmez.
4. **Veri modeli mevcut kataloğu kullanır, ayrı veritabanı yoktur:**
   `catalog_intake_record` (ara depo, TS yalnız ekler) → Python `feeds hb-merge`
   mevcut `FeedSync` hattıyla `offer`, `seller`, `price_point`, `search_outbox`,
   `feed_source`/`source_snapshot`/`ingest_chunk` yazar. TS `offer` yazmaz
   (mimari sınır). `merchant`: `hepsiburada` (affiliate yok; çıkış yine `click`
   kaydıyla kanonik adrese gider, kural 8).
5. **Kota sistem seviyesinde (migration 0070 tetikleyicileri):** `collection_run`
   rezervasyonu en az 7 gün aralığı ve takvim ayında (UTC) 4 koşuyu uygulama
   kodundan bağımsız zorlar; koşu süresi (6 gün) aralıktan kısadır; açık koşu kaynak
   başına tek; manuel/CLI/ilk yükleme aynı tabloyu kullanır; `arilla_app` politikayı
   ve koşu satırlarını silemez, kapanmış koşu yeniden açılamaz. Hiç istek atılmadan
   bırakılan koşu (`released`) kotadan düşülür. Başarısız bir koşu da hak harcar:
   yeniden deneme aynı açık koşuyu **sürdürmektir** (checkpoint), yeni koşu değil;
   koşu süresi (6 gün) dolarsa kapanır ve 7 günlük aralık ondan sayılır.
6. **İstek bütçesi, ilk yükleme ve güncelleme ayrı:** kaynağın ilk kotaya sayılan koşusu
   `initial`, sonrakiler `refresh` olur (tetikleyici yazar). Bütçeler
   `collection_source.initial_max_requests` / `refresh_max_requests` ile ayarlanır
   (varsayılan 500/500; işletici güvenlik valfi, Hepsiburada'nın bildirdiği bir sayı
   değildir). İlk yükleme kotadan muaf değildir. Bildirilen izin dayanağındayken politika
   7 günden kısa aralığa ya da ayda 4'ten fazla koşuya CHECK ile gevşetilemez. Bütçe sunucuda zorunlu. İstekler arası en az
   2 sn. 403/429/503, doğrulama sayfası ya da beklenen yapının yokluğunda koşu durur;
   yeniden deneme ve alternatif yöntem yoktur.
   **Yanıt hiç alınamazsa** (tarayıcı `fetch` hatası: ağ/DNS, zaman aşımı, okunamayan yanıt;
   kod `network_error` / `timeout`) bu bir engel kanıtı değildir: koşu durur ama **kapatılmaz**.
   Hata adı ve mesajı yönetici günlüğüne yazılır; yönetici nedeni giderip aynı koşuyu aynı
   sayfadan sürdürür (istek bütçesinden düşer, yeni kota hakkı harcanmaz). Otomatik yeniden
   deneme yoktur. (15 Ekim 2026: ilk production koşusu bu durumda kapatılıp 7 günlük aralığı
   başlatmıştı.)
7. **Değişen veri, gereksiz WAL yok:** parmak izi eşleşen satır yeniden yazılmaz,
   `price_point` yalnızca yeni/değişen fiyat-stokta eklenir (0114'teki ölçüme dayanan
   mevcut birleştirme).
8. **Eksik sonuçtan ürün silinmez.** Kaynak tam katalog vermez, taranan alt kümeyi
   verir. Besleme `no_deactivate` ayarlıdır: hiçbir `offer` pasifleşmez, parça sayısı
   karşılaştırması yapılmaz. Güvenilir kaldırılma bilgisi (kaynakta 404/stokta yok
   işareti) kullanılmadığı sürece ürün "belirsiz" kalır; tazelik `last_seen_at` ile
   görünür. Kaldırılanı işleme, güvenilir sinyal eklenince ayrı bir karardır.
9. **Yanlış fiyat koruması:** fiyat tam metinle kuruşa çevrilir (2'den fazla ondalık,
   virgül, bilimsel gösterim elenir). Birleştirmede mevcut teklif fiyatından 5 kat ve
   üstü sapma otomatik işlenmez, `ingest_error` (`price_jump_held`) olarak incelemeye
   ayrılır. Liste fiyatı ürün sayfasıyla yalnızca 6 üründe karşılaştırılmıştır (arşiv).
   **Eksik alan uydurulmaz.** Listede olmayan alanlar boş kalır: satıcı, GTIN, kategori,
   varyant, stok adedi. Ana satıcı (kimlik ya da ad; yalnız ad varsa `name:<slug>` anahtarı,
   ad yalnızca boş `seller.name`'e yazılır) ve varyant etiketi (`attributes_raw.variant`)
   hattı uçtan uca kuruludur. Kaynak olan ürün sayfası okuyucusu (`extract-product-page.ts`,
   standart JSON-LD) gerçek örnekle doğrulanmadığından toplayıcıya BAĞLI DEĞİLDİR. Stok bilinmiyorsa (`in_stock` NOT NULL olduğundan) `false`
   yazılır ve `attributes_raw.stock_state = "unknown"` işaretlenir; "stokta" denmez.
10. **Zaman alanları ayrı:** kaynaktan okunma anı `catalog_intake_record.source_observed_at`,
    sunucuya geliş `received_at`, birleştirme `merged_at`; teklifte `last_seen_at`,
    `price_point.observed_at` (koşunun son kaynak zamanı). Ayrı bir "son doğrulama"
    sütunu eklenmedi: bağımsız doğrulama `price_verification` (0113) işidir ve
    Hepsiburada için izinli sağlayıcı yoktur (kaynak sunucudan erişilemez).
11. **Denetim:** koşu başlatma ve kapatma `admin_audit_event`'e yazılır
    (`catalog_collection.*`), ürün içeriği yazılmaz.
12. **CSP:** yalnızca `/yonetim/katalog/toplama` yolunda `connect-src`'ye
    `https://www.hepsiburada.com` eklenir; genel ve diğer yönetim yollarında yoktur.
    `img-src https:` zaten izinlidir; kullanıcılara görseller mevcut galeri hattından
    (`offer_image`) gelir.
    **Tam yükleme şartı (17 Ekim 2026):** tarayıcı CSP'yi yalnızca belge yüklenirken uygular.
    Panelden istemci geçişiyle (next/link) gelinirse ilk sayfanın `connect-src 'self'` kuralı
    kalır ve istek tarayıcıda engellenir ("Failed to fetch"; koşu #1 ve #3'ün ilk denemesi).
    Menü bu sayfaya düz bağlantıyla gider, sayfa istemci geçişini algılayınca kendini bir kez
    yeniden yükler ve toplayıcı belge bu yolda yüklenmediyse istek atmaz. Sitemap keşfinde
    yanıtsız istek (ağ/CSP/zaman aşımı) birimi `failed` yapmaz, deneme hakkını yakmaz; koşu açık kalır.

## Kapsam sınırı (güvenilir keşif)

- Tek sayfa ≤ 36 ürün (arşiv ölçümü). `&sayfa=N` sayfalamasının çalıştığı **bu karar
  yazılırken canlı doğrulanmadı** (Hepsiburada'ya istek atılmadı). Toplayıcı bunu koşuda
  ölçer: sonraki sayfa yeni ürün getirmiyorsa sorgu orada biter ve kapanış raporunda
  `queriesPaginationUnconfirmed` olarak görünür; tavana takılan sorgu
  `queriesCappedByPageLimit` ile raporlanır.
- Keşif **yöneticinin verdiği sorgu listesiyle** sınırlıdır; tüm kataloğa erişim
  varsayılmaz. Arama sonucu, sorguya göre sıralı ve değişkendir; kapsam yüzdesi
  hesaplanamaz, yalnızca benzersiz ürün, sorgu ve sayfa sayıları raporlanır.
- Kategori sayfaları, sitemap ve robots durumu doğrulanmadı; ayrı bir keşif işi.
- Bir koşu 500 istek × ≤ 36 ürün = en fazla ~18.000 ürün satırı, ayda en fazla 4 koşu.

## Reddedilen alternatifler

- **Kullanıcı tarayıcısından canlı arama:** KVKK/üçüncü taraf kuralları, ölçek ve
  toplu otomasyon riski; ürün sahibi vazgeçti.
- **Sunucudan/VPS'ten çekme, proxy, headless tarayıcı:** erişim engelini aşmak olur.
- **Kotayı yalnızca uygulama kodunda tutmak:** başka yol (CLI, test, yeni kod) atlar;
  tetikleyici tek zorlayıcıdır.
- **Eksik gelen ürünü pasifleştirmek:** alt küme taramasında yanlış kaldırma üretir.
- **Ayrı Hepsiburada tabloları/veritabanı:** mevcut `offer` modeli ve AliExpress
  beslemesiyle aynı hat yeterli.

## Açık işler

Gerçek HTML örneği yok: arşivde kayıtlı Hepsiburada sayfası bulunmuyor; çıkarıcı eski
çalışan yöntemle sentetik veride birebir karşılaştırıldı (görselsiz ürün tek farktır:
yeni kod tutar, `image_url` boş kalır). İlk pilot bu yüzden gerçek örnek üretmelidir.
Aynı ürünün `-p-` ve `-pm-` kodlarıyla iki ayrı teklif olması mümkündür (doğrulanmadı).
Yazılı izin; sayfalama ve ürün sayfası (satıcı, varyant, GTIN) için canlı doğrulama
(izinli ve onaylı küçük deneme); `collection_source.enabled` açılışı; `hb-merge`
zamanlaması (bilerek yok); güvenilir kaldırılma sinyali.
