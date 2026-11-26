# 0220 — Hepsiburada'yı canlandırma: barkod, haftalık tazelik ve tarayıcı zamanlayıcısı

**Tarih:** 26 Kasım 2026
**Durum:** Önerildi (PR). Şema değişikliği YOK (migration yok). Üretimde hiçbir şey çalıştırılmadı;
Hepsiburada'ya istek atılmadı. Zamanlayıcı bayrağı varsayılan kapalı.
**İlişkili:** 0111 (kimlik düzeyi), 0117 (yönetici tarayıcısından toplama; bu karar "otomasyon"
bölümünü ekler), 0124 (hacim kotası), 0130 (katalog birleşimi), 0164 (kaynak kayıt defteri).

## Sorun (üretim, salt okunur, Kasım 2026)

- Hepsiburada (merchant 28): 2.017 teklif, hepsinin `last_seen_at` değeri 16 Ekim; tek `hb_merge` 17 Ekim.
  Yenileme yok: toplama tamamen elle, kimse sayfayı açmayınca katalog bayatlıyor.
- 2.017 yayınlanmış ürün: `gtin` 0, `category_raw` 0. `product_identity` yazıcısı yok, `match_candidate`
  boş, `resolve` her gece `no_eligible_offers`. Kesin kimlik (barkod) olmadan başka mağazayla eşleşme yok.
- Çelişki: kayıt defterinde HB `max_price_age = 2 gün`, `min_refresh_interval = 24 saat`; bildirilen izin
  (0117) haftada 1 yenileme. Kapı her HB ürününü 2 gün sonra `stale_source_offer` yapıyordu: izin içinde
  toplanan veri bile yayına çıkamaz.
- Toplayıcı yalnız `/ara?q=` liste JSON-LD'sini okur; bu listede barkod/kategori varsa da atılıyordu.

## Karar

### 1. Barkod (yalnız zaten okunan sayfadan)

- `extract-hepsiburada.ts`: liste öğesinde schema.org `gtin`/`gtin13`/`gtin14`/`gtin12`/`gtin8` ya da
  `category` VARSA alınır. **Ek istek yok**; ürün sayfası okuyucusu (`extract-product-page.ts`) yine
  toplayıcıya bağlı değildir (0117 §9, 0124 §7). Listede yoksa alan boş kalır, uydurulmaz.
- Sunucu doğrulaması (`validate.ts`) değişmedi; `feeds hb-merge` → `normalize` barkodu
  `identity_policy.classify_gtin` ile süzer (kontrol basamağı, kısıtlı GS1 önekleri, 14 hane) ve
  `offer.attributes_raw.gtin`'e yazar (mevcut hat).
- Yeni yazıcı `python -m catalog_build identity --merchant hepsiburada [--dry-run]`: kaynak ürününe
  `product.gtin` yazar. Kurallar (0111): yalnız `valid`; yalnız varyant adresi (`-p-`; `-pm-` model/grup,
  `IdentityRule.gtin_url_kinds`); kaynakta aynı barkod birden çok üründe ise hiçbirine; başka üründe
  varsa yazılmaz; var olan değer ezilmez. İdempotent, `job_run` = `catalog_identity`.
- **`product_identity` yazılmaz.** GTIN satırı `canonical_variant_id` ister; kanonik varyant yazıcısı
  yoktur ve varyant uydurmak 0111'e aykırıdır. `resolve` zaten `product.gtin` (yayınlanmış ürün)
  üzerinden kesin kimlik adayı üretir; bağ `method = gtin` ile kurulur ve vetolar geçerlidir.
- HB teklifleri `resolve`'a yine girmez (0130, `SOURCE_LISTING_MERCHANTS`). Eşleşme yönü:
  kaynak ilanı OLMAYAN mağazanın barkodlu teklifi → HB ürünü.

### 2. Kaynak başına tazelik (küresel değişiklik yok)

- `platforms/registry.py` HB: `min_refresh_interval = 7 gün`, `max_price_age = 8 gün` (haftalık yenileme +
  1 gün pay). AliExpress 2 gün olarak kalır.
- `catalog_build gate|publish|auto`: `--stale-days` verilmezse her ürün kendi kaynağının sınırıyla
  değerlendirilir (`source_config.stale_days_map`, SQL'e jsonb). Verilirse kaynak sınırıyla küçüğü
  uygulanır (yalnız sıkılaştırır). Kayıtsız kaynak eski davranıştadır (2 gün ya da verilen değer).
- Web okuma yolundaki fiyat doğrulaması (0156 `feed_source.config.freshness`) bu kararda **açılmadı**:
  HB beslemesine politika yazmak bugünkü 40 günlük teklif fiyatlarını hemen gizler. İlk taze koşudan
  sonra `source_stale_after_days = 8` ayrı onayla eklenmelidir (aşağıda "Açık işler").

### 3. Zamanlanmış yenileme (0117 "otomasyon" eki)

- Toplama **yine yalnız yöneticinin tarayıcısında** çalışır. Sunucu/VPS/headless/proxy yok; Akamai
  aşılmaz. `/yonetim/katalog/toplama` sayfası açık, görünür, belge bu yolda yüklenmiş (CSP, 0117 §12) ve
  oturum geçerliyken sayfadaki zamanlayıcı 10 dakikada bir sunucuya sorar (`op: schedule_status`).
- Karar **sunucuda** verilir (`schedule.ts`, `startScheduledCollectionRun`), `collection_source`
  politikası daha gevşek olsa bile (0124 `declared_extended`, aralık 0) kodda uygulanır:
  son sayılan koşudan (`released` dışı her koşu; elle, ilk yükleme dahil) **en az 7 gün**, UTC takvim
  ayında **en fazla 4 koşu**, açık koşu yok, kaynak açık ve hacim kotası var, bayrak açık.
  Ayrıca tetikleyici (0070/0075) ve tek-açık-koşu indeksi son sözü söyler (iki sekme aynı anda açamaz).
- Zamanlanmış koşu **parametre almaz**: son kapanmış arama koşusunun sorgu listesi ve sayfa tavanı
  kullanılır. İlk koşu her zaman elle başlatılır (şablon yoksa `no_template`).
- `schedule_start` taze giriş istemez (koşu günler sonra tetiklenir); bunun karşılığında istemci
  sorgu, bütçe ya da zaman seçemez ve başlatma `admin_audit_event`'e
  `catalog_collection.schedule_start` (şablon koşu, sorgu sayısı) olarak yazılır. Elle `start` yine
  taze giriş ister.
- Akış elle koşunun aynısıdır: istekler arası ≥ 2 sn (varsayılan 4), sunucu bütçesi, 403/429/503 ya da
  yapı yokluğunda durma. Açık kalan koşu **otomatik sürdürülmez** (0117: otomatik yeniden deneme yok).
- Bayrak: web ortamında `CATALOG_AUTO_COLLECT_ENABLED=true` (varsayılan kapalı).

### 4. Yönetim görünürlüğü

- Toplama sayfası: "Zamanlanmış haftalık yenileme" kartı (durum, izne göre en erken zaman, bu ay x/4,
  engel nedeni); huni: tazelik (sınır 8 gün; bayat aktif teklif, en yeni/en eski görülme), barkodlu
  teklif ve barkodu yazılmış ürün.
- İşletim bulguları (`/yonetim/islemler`, genel bakış): `collection.hepsiburada.freshness` — aktif HB
  tekliflerinin hiçbiri 8 günde görülmediyse `warning`; son koşu yarıda kaldıysa `info`.

## Etkinleştirme (elle, sırayla; üretim onayı kullanıcıda)

1. PR birleşip dağıtıldıktan sonra yöneticinin tarayıcısında `/yonetim/katalog/toplama` (tam sayfa
   yüklemesi) → sorgu listesiyle **elle** bir koşu (kotadan 1 hak; şablonu bu oluşturur).
2. VPS: `python -m feeds hb-merge --run <kapanan koşu>` → `python -m catalog_build build --merchant
   hepsiburada` → `python -m catalog_build identity --merchant hepsiburada --dry-run`, sonra `--dry-run`
   olmadan → `gate` → `publish --merchant hepsiburada --limit N --confirm`.
3. Otomasyon için web ortamına `CATALOG_AUTO_COLLECT_ENABLED=true` ekleyip web'i yeniden başlatmak (ayrı
   onay). Sonra toplama sekmesi açık kaldıkça 7 günde bir koşu kendiliğinden başlar.
4. `hb-merge` ve sonrası hâlâ elle (zamanlayıcı yok; bu karar sunucu tarafı zamanlayıcı kurmaz).

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| VPS/headless tarayıcı ya da proxy ile zamanlanmış toplama | Erişim engelini aşmak olur (0117 §1) |
| Tarayıcı eklentisi `chrome.alarms` | Yeni dağıtım yüzeyi ve izin; mevcut sayfa zamanlayıcısı aynı işi bayraklı ve sunucu kararlı yapar |
| Kotayı yalnız `collection_source` politikasına bırakmak | Üretim politikası `declared_extended` (aralık 0); otomasyon bildirilen haftalık izni aşabilirdi |
| HB ürün sayfası okuyarak barkod | Ek istek; 0124 §7 kapsam dışı, okuyucu gerçek örnekle doğrulanmadı |
| `product_identity` + sahte kanonik varyant | 0111: varyant uydurulmaz |
| Küresel `PUBLISH_STALE_DAYS`'i 8 yapmak | AliExpress günde iki kez gelir; 8 gün bayat fiyatı yayına sokar |

## Açık işler

- Liste JSON-LD'sinde barkod bulunduğu **doğrulanmadı** (gerçek sayfa örneği yok). İlk koşudan sonra
  huni "Barkodlu kayıt" 0 kalırsa barkod için ürün sayfası okuma ayrı ve onaylı bir karar gerektirir.
- HB beslemesine `freshness.source_stale_after_days = 8` (ilk taze koşudan sonra, onaylı).
- `hb-merge` → `identity` zincirinin zamanlanması (VPS zamanlayıcısı; ayrı onay).
- Üretimde `collection_source` politikası (`declared_extended`) ile 0117 beyanı arasındaki fark
  kullanıcı tarafından netleştirilmeli; otomasyon her durumda haftalık sınırda kalır.
