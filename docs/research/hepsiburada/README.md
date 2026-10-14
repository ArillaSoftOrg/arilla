# Hepsiburada Ar-Ge arşivi (12–15 Ekim 2026)

Bu belge, Hepsiburada gerçek ürün verisine erişim için yapılmış tüm çalışmaların tek
kaydıdır. Amaç: çalışan yöntem, başarısız denemeler ve sınırlamalar kaybolmasın.

- **Yeni istek yok.** Bu belge hazırlanırken Hepsiburada'ya hiçbir istek gönderilmedi.
  Tüm ölçümler aşağıda gösterilen eski oturum kayıtlarından alınmıştır; bu oturumda
  yeniden doğrulanmadı.
- **Üretime bağlı değil.** Burada anlatılan hiçbir şey `main`'de çalışmıyor ve
  çalıştırılmamalı: hukuki izin yok (bkz. 7).
- Teknik erişim, ticari kullanım izni değildir. CORS başlığı içerik lisansı değildir.

## 1. Kısa sonuç

| Soru | Cevap |
|---|---|
| Sunucudan erişim | **Yok.** Akamai 403 (robots.txt dahil). |
| Ziyaretçi tarayıcısından erişim | **Var, kanıtlı.** `/ara?q=` sayfası `Access-Control-Allow-Origin: *` döndürür. |
| Alınan alanlar | ad, ürün bağlantısı, fiyat (TRY), görsel, `InStock` durumu, (ürün sayfasından) GTIN |
| Alınamayan alanlar | satıcı, varyant ayrımı, stok adedi (listede yok) |
| Resmî veri kanalı | Doğrulanmadı (feed/API bulunamadı). |
| Ticari izin | **Belirsiz.** Kullanım koşulları okunamadı. |

## 2. Çalışan yöntem: ziyaretçi tarayıcısından CORS ile okuma

```
fetch("https://www.hepsiburada.com/ara?q=<sorgu>", { mode: "cors", credentials: "omit" })
```

1. Arama yolu robots.txt'te yasak değil (`/ara` için kural yok; normal ziyarette okundu).
2. Sonuçlar sunucu tarafında HTML'e gömülü. Ek XHR gerekmez.
3. Yanıt `Access-Control-Allow-Origin: *` taşır, çerezsiz okunabilir. Yanıt 200,
   2–4,6 MB HTML.
4. Veri yolu: `<script id="reduxStore">` → `voltranState.fragmentsMap.*.ProductList.seoState.itemListElement`.
   Değer **JSON metnidir** (içte ikinci bir `JSON.parse` gerekir). İçerik schema.org ItemList.
   Her öğede `name`, `url`, `image`, `offers.price`, `offers.priceCurrency`,
   `offers.availability`.
5. Görseller herkese açık CDN'de: `productimages.hepsiburada.net`.
6. Ürün sayfası da CORS'a açık: JSON-LD ve durum içinde `"gtin"` ve varyant `"barcode"`
   alanları var (GTIN zinciri).
7. Kategori fasedi: `VerticalFilter.html` içinde `"key":"AllCategories.CategoryId"` →
   `values[].displayName`. Yalnızca üst düzey ("Telefon", "Elektronik"); zayıf kanıt.

Üç koşul birden gerekir: robots izni, sunucu tarafı gömülü veri, açık CORS. Diğer 7
platformda üçüncüsü hiçbir sayfa türünde bulunmadı (`arastirma-gunlugu.md`).

### Kod konumları

| Ne | Yer |
|---|---|
| Üretim kalitesine yakın çıkarıcılar `extractHepsiburada`, `extractHepsiburadaGtins`, `extractHepsiburadaCategoryFacet`, `LIVE_STORES` | `packages/core/src/live-search-browser/stores.ts`, dal `research/tr-live-product-search`, commit `7b3c474` |
| Başlık eşleştirici (aksesuar, durum, varyant kuralları) | `packages/core/src/live-search-browser/match.ts` (aynı dal) |
| Eşleştirici ve çıkarıcı testleri | `packages/core/src/live-search-browser/live-search-browser.test.ts` (aynı dal). "44 regresyon testi" ifadesi hafıza notundan; dosyada 11 `it(` bloğu + 1 `it.each` var. Sayı doğrulanmadı. |
| İlk kanıt sayfası (localhost'tan CORS ölçümü) | `prototypes/live-search-web-probe/` (bu arşiv). Daha önce hiçbir commit'te yoktu. |
| Chrome eklentisi (kullanıcının açtığı sekmeden okur) | `prototypes/live-search-extension/` (bu arşiv). Daha önce hiçbir commit'te yoktu. HB için `findHepsiburadaItemList` + `extractJsonLd`. |
| Sunucu tarafı prototip (çalışmıyor, 403) | `packages/core/src/hepsiburada-discovery/`, `docs/hepsiburada-discovery-prototype.md`, commit `32dda19` / `2c90768` (#124, `main`'de) |

Not: Önceki bir özet, `tr-live-search` araştırma belgelerini "commit'siz" diye
tanımlamıştı. Yanlış. İkisi de `7b3c474` içinde commit'li ve origin'de:
`docs/research/arastirma-gunlugu.md`, `docs/research/canli-arama-platformlari.md`.
Commit'siz olan yalnızca bu arşivdeki iki prototip klasörüydü.

## 3. Alan alan durum

| Alan | Durum | Kanıt |
|---|---|---|
| Ürün adı | Alınıyor | ItemList `name` |
| Ürün kimliği | Kısmen. URL'de `-p-<KOD>`/`-pm-<KOD>` biçimi; ayrı kimlik alanı çıkarılmıyor. GTIN yalnızca ürün sayfasından | `stores.ts`; GTIN: 16 üründen 13 (2'si `0000…` uydurma, reddedildi; 15 haneli geçersiz) |
| Fiyat | Alınıyor (kuruş tamsayı) | Liste ↔ ürün sayfası 6/6 tutarlı (3'ü HB). iPhone 16 Pro Çöl Titanyum 130.000,00; Sony WH-1000XM5 15.749,00; LEGO 42233 289,00 (44 parçalık küçük set, veri hatası değil). `arastirma-gunlugu.md`, "1.2" ve "1.3" |
| Görsel | Alınıyor | Eşleşen ürünlerin görselleri `Image()` ile yüklendi (Samba 35/35, PS5 23/23). Aynı kayıt, "1.6" |
| Satıcı | **Listede yok.** Ürün sayfasında başka satıcı fiyatı görüldü (15.489 TL) ama ayrıştırılmadı | aynı kayıt, "1.2" |
| Varyant | **Ayrıştırılmıyor.** Ürün sayfasında diğer renklerin fiyatı var (119.499 TL gibi) | aynı kayıt |
| Stok | `InStock`/`OutOfStock`/`SoldOut` eşlemesi; adet yok | `stores.ts` `availabilityOf` |
| Ürün bağlantısı | Doğrudan ürün sayfası; `hepsiburada.com` alan adına kısıtlı | `stores.ts` `httpsUrlOn` |
| Arama sonuçları | İlk sayfa, en fazla 36 ürün | probe README ölçümleri |

### Gerçek tarayıcı ölçümleri (12 Ekim 2026)

Probe, localhost'tan (`apps/live-search-web-probe/README.md`):

| Sorgu | Sayfada | Eşleşen | Süre | Boyut |
|---|---|---|---|---|
| iPhone 16 Pro | 36 | 4 | 2,3 sn | 2,8 MB |
| Sony WH-1000XM5 | 25 | 5 | 1,7 sn | — |

Paketlenmiş kodla, `127.0.0.1:4599` kökeninden (4. oturum): HB "Lego Technic" 36 sayfa / 5
eşleşen. Paket sha256 `dc25d151…b298` (harness repo dışındaydı; arşivlenmedi).

Sorgu sonuçları (`canli-arama-platformlari.md`, `arastirma-gunlugu.md` "5. oturum"):

| Sorgu | Sayfada / eşleşen (3. tur) |
|---|---|
| iPhone 16 Pro 128 GB | 3 / 3 |
| Adidas Samba | 36 / 35 |
| Siyah kadın elbise | 36 / 8 |
| Sony WH-1000XM5 | 25 / 13 |
| PlayStation 5 | 36 / 17 (12 paket) |
| Lego Technic | 36 / 35 |
| iPhone 13 128 GB | 36 / 10 |
| Dyson V15 | 36 / 9 → son pakette 4 |

Kararlılık: aynı gün 4 tur, mağaza başına yaklaşık 50 istek, hepsi HTTP 200, engel veya
doğrulama sayfası yok, 1–2,6 sn. **Ölçülmeyen:** başka ağ (mobil hat), başka tarayıcı
profili, uzun süreli kararlılık.

## 4. Başarısız denemeler ve çelişki

| Deneme | Sonuç | Kayıt |
|---|---|---|
| Sunucudan `robots.txt`, dürüst User-Agent | 403, Akamai (`HBBlockandCaptcha`, `AKReferanceId`) | `hepsiburada-discovery-prototype.md` |
| Sunucudan arama/ürün sayfası | robots doğrulanamadığı için hiç istenmedi | aynı |
| Sunucu proxy'si, sunucuda headless tarayıcı | Kapsam dışı sayıldı (bot koruması aşma) | probe README, seçenek A/B |
| iframe ile gömme | `frame-ancestors` yalnızca `*.hepsiburada.com`, `*.hepsipay.com` | probe README, D |
| Tarayıcıdan `robots.txt` | 503, ACAO yok → `Failed to fetch` | `canli-arama-platformlari.md` |
| `credentials:"include"` | Başarısız (wildcard ACAO çerezli isteğe izin vermez) | probe README |

**Çelişki ve nedeni.** `hepsiburada-discovery-prototype.md` "canlı keşif çalışmıyor",
probe README ve `canli-arama-platformlari.md` "çalışıyor" diyor. İkisi de doğru: ilki
sunucu yolunu, ikincisi tarayıcı yolunu ölçtü. Ayrıca bir test `robots.txt`'i
(CORS'suz, 503), diğeri `/ara?q=`'u (CORS'lu, 200) okudu; ilk rapor hatası buydu
(`canli-arama-platformlari.md`, "Hepsiburada çelişkisinin nedeni").
Prototip belgesi güncellenmedi; "HB tümüyle kapalı" okuması yanlıştır.

Karar 0023 ve 0027 Trendyol/Hepsiburada'yı "kapalı sistem, dokunulmaz" diye işaretler.
Tarayıcıdan okuma bu ilkeyle gerilimlidir; entegrasyondan önce revize edilmeli.

## 5. Bilinen eşleştirme hataları

- Dyson V15: "V15s, V15, V11, V10 ve V8 İçin Çok Yönlü Temizlik Seti" gibi çoklu
  uyumluluk aksesuarları geçiyor (4 sonucun 2'si). "için" kelimesini aksesuar saymak
  LEGO'yu bozar ("Çocuklar için"). Hipotez: başlıkta 3 veya daha fazla farklı model
  kodu = uyumluluk listesi. **Uygulanmadı.**
- Paket ürünler ("PS5 Slim + şarj istasyonu") eşleşmeden geçer; arayüzde `isBundleTitle`
  ile "paket" etiketi öngörüldü.
- Giyimde "kol" ve "mini" aksesuar/varyant değildir (gerileme yakalandı, düzeltildi).

## 6. Resmî kanallar (HB)

- Merchant API yalnızca satıcı içindir.
- Affiliate/Linkgelir var, ürün feed'i doğrulanamadı (`hepsiburada-discovery-prototype.md`,
  `apps/live-search-web-probe/README.md`).
- Katalogdaki feed hattı (karar 0111, 0112) yalnızca Admitad/AliExpress için kurulu.
  Hepsiburada için feed profili yok.

## 7. Hukuk, KVKK ve proje kuralları

CORS izni teknik sinyaldir, lisans değildir. Hepsiburada kullanım koşulları okunamadı
(sözleşme sayfası girişe yönlendiriyor). Ürün verisi ve görselini ManiCepte arayüzünde
göstermek için yazılı izin veya hukuki görüş gerekir.

| Kural | Etki |
|---|---|
| Üçüncü taraf kaynak yasağı, karar 0087 | Tarayıcı, ziyaretçinin IP'sini ve sorgusunu Hepsiburada'ya gönderir; görseller HB CDN'inden yüklenir. Açık bilgilendirme/rıza ve ayrı ADR gerekir. CSP'ye `connect-src` ve `img-src` eklenir. |
| Kural 8 (`click`) | Bu bağlantılar affiliate değil; 0102 istisnasına benzer bir istisna kararı gerekir. |
| Kural 3 | Sonuçlar katalog verisi değil; saklama kararı ayrıdır. |
| Kararlılık | `Access-Control-Allow-Origin: *` ve `reduxStore` yapısı sözleşme değildir, haber vermeden değişebilir. |
| Performans | Arama başına 2–4,6 MB; mobil veri. Yalnızca ilk sayfa. |
| Ölçek | Her ManiCepte araması bir HB isteğidir; yoğun trafik toplu otomasyon sayılabilir. Hız sınırı ve bayrak gerekir. |

## 8. PostgreSQL katalog mimarisiyle entegrasyon incelemesi

Entegrasyon kodu yazılmadı. Bu bölüm inceleme sonucudur. İncelenen kayıtlar:
`CLAUDE.md` değişmez kurallar, `docs/schema.sql`, karar 0102, 0106, 0111, 0113, 0114.

### Neden doğrudan katalog beslemesi olamaz

1. **Mimari sınır.** Python HTTP sunmaz ve tarayıcı yöntemi yalnızca ziyaretçi
   tarayıcısında çalışır. VPS'teki Python işçisi HB'ye gidemez (Akamai 403). Toplu bir
   ingest hattı bu yolla kurulamaz.
2. **Kural 4 ve 3.** `price_point` yalnızca INSERT. Tarayıcıdan gelen, doğrulanamayan
   bir fiyat oraya yazılırsa düzeltilemez. Ayrıca bu veri 0102'deki internet sonuçları
   gibi "katalog verisi değildir" kategorisine girer.
3. **Güven.** Ziyaretçinin tarayıcısından sunucuya geri gelen veri güvenilmez girdidir
   (sahtecilik, zehirleme). Sunucu doğrulamaz çünkü HB'ye erişemez.
4. **Kural 7.** İdempotent toplu ingest ve `(merchant_id, external_id)` kısıtı
   tarayıcı kaynağına uymaz.

### Üç olası biçim

| Seçenek | Ne yapar | Kural uyumu | Eksik |
|---|---|---|---|
| **A. Geçici gösterim** (öneri) | Sonuçlar yalnızca tarayıcıda, katalog kartlarıyla aynı `ProductCard` ızgarasına eklenir. Veritabanına yazılmaz. | 0102/0106 örüntüsüne en yakın. Kural 3 istisnası, kural 8 istisnası, kural 1 ihlali yok (model yok). | Yeni ADR, KVKK/rıza metni, CSP, bayrak, hız sınırı, hukuki onay, `ResultGrid` `extra` yuvasına istemci tarafı veri |
| B. Barkod ipucu | HB ürün sayfasından GTIN alınır; yalnızca GTIN sunucuya gider ve `identity_observation`'a aday olarak yazılır. Kimlik kuralı (0111): kontrol basamağı doğru, `0000…` ve 15 haneli reddedilir. | Otomatik birleştirme yok (`hold`/`unmatched`). Kullanıcı sorgusu sunucuya gitmez. | Güvenilmez kaynak puanı, kötüye kullanım koruması, `identity_observation` şemasının istemci kaynağını kabul etmesi |
| C. Fiyat doğrulama sağlayıcısı | `PriceVerificationProvider` (0113) olarak `hepsiburada_browser`. | Zayıf: sağlayıcı sunucu tarafında çalışır; HB sunucudan erişilemez. | Kullanılamaz, istemci kaynaklı doğrulama farklı mimari ister |

Önerilen sıra: yalnızca A; B ancak HB ile resmî ilişki kurulursa.

### Katalog entegrasyonunda eksikler

- Hukuki izin ve kullanım koşulları (en büyük engel).
- ADR: tarayıcıdan üçüncü tarafa istek, KVKK, 0087 ve font/betik kuralıyla ilişki,
  0023/0027 revizyonu. Not: PR #125'teki 0106 numarası `main`'deki 0106 ile çakışıyordu.
- Kod `apps/web`'e değil `packages/core`'a taşınmalı (kural 6); şu an
  `research/tr-live-product-search` dalında, bu dal `main`'den ayrışmış.
- `HB` için `merchant` kaydı: sonuçlar katalogda `offer` olmadığı için gerekmez (A);
  B/C için gerekir.
- Satıcı ve varyant çıkarımı yok; ürün sayfası ayrıştırması yazılmadı.
- Hız sınırı, devre kesici, sorgu önbelleği: Pazarama için yazıldı
  (`host-gate.ts`, `page-cache.ts`; `5119ea5`), HB için ziyaretçi tarafında karşılığı yok.
- Mobil veri maliyeti (2–4,6 MB) için akış kesme ya da `Range`/erken çıkış ölçülmedi.
- Başka ağ, başka tarayıcı profili ve zaman içinde kararlılık ölçümü yok.
- Eşleştirme: çoklu uyumluluk aksesuarı kuralı uygulanmadı.
- `price_verification` ve `click` şemasına tarayıcı kaynaklı gözlem için alan yok.

## 9. Sıradaki somut teknik adım

1. Hepsiburada ile yazılı izin / veri anlaşması yolunu başlat (iş geliştirme). Cevap
   gelmeden üretime hiçbir şey alınmaz.
2. İzin gelirse ADR yaz (seçenek A), ardından `live-search-browser` kodunu
   `packages/core`'a, bayrakla (varsayılan kapalı) taşı; `ProductCard` ızgarasına
   istemci tarafı `extra` olarak ekle.
3. Teknik risk için tek ölçüm: kullanıcı mobil hatta ve ikinci bir tarayıcı
   profilinde mevcut harness'i çalıştırır (yeni istek, kullanıcı elinde, ayrıca onay).
4. Dyson tipi uyumluluk aksesuarı kuralını (≥3 farklı model kodu) regresyon testiyle ekle.

## 10. Bu arşivin içeriği

| Yol | Kaynak | Not |
|---|---|---|
| `docs/research/hepsiburada/README.md` | bu belge | |
| `prototypes/live-search-web-probe/` | ana checkout `apps/live-search-web-probe/`, dal `research/live-search-extension`, daha önce untracked | birebir kopya; tek fark: `index.html`'de `<button>` → `<button type="submit">` (biome `useButtonType` kuralı, davranış aynı) |
| `prototypes/live-search-extension/` | ana checkout `apps/live-search-extension/`, daha önce untracked | birebir kopya; `node_modules/` (boş) hariç |

Orijinal klasörler yerinde bırakıldı. Gizli anahtar, token, çerez veya kişisel veri
taranarak yok olduğu doğrulandı (yalnızca `tokenize` işlev adı eşleşti).
Kopyaların sha256 değerleri orijinallerle karşılaştırıldı; `index.html` hariç hepsi aynı.

Aşağıdaki dosyalar **başka dallarda commit'li**, bu arşive kopyalanmadı, yalnızca
referans verildi:
`research/tr-live-product-search` (`7b3c474`; `5119ea5` bu dizine dokunmadı):
`docs/research/arastirma-gunlugu.md`, `docs/research/canli-arama-platformlari.md`,
`packages/core/src/live-search-browser/*`.
