# Canlı ürün araması — araştırma günlüğü

Uzun süreli araştırma. Her oturum sonunda güncellenir. Özet ve ilk sınıflandırma:
`canli-arama-platformlari.md`. Prototip: `packages/core/src/live-search-browser/`.

Kurallar (her oturumda): CAPTCHA/bot koruması/CORS aşma yok; UA taklidi, proxy,
çerez yok; robots.txt'e uyulur; 403/429/doğrulama sayfasında o yöntem için durulur ve
aynı yöntem tekrarlanmaz. Teknik erişim ≠ ticari kullanım izni.

## Çalışan yöntemin teknik imzası (HB, ÇS)

1. Arama sayfası robots.txt'te yasak değil.
2. Arama sonuçları **sunucu tarafında** HTML'e gömülü (HB: `reduxStore` ItemList; ÇS: Next.js
   RSC `"products":[...]`). İstemci tarafı XHR'a gerek yok.
3. HTML yanıtı `Access-Control-Allow-Origin: *` taşıyor → tarayıcı çerezsiz okuyabiliyor.
4. Görseller herkese açık CDN'de (`productimages.hepsiburada.net`, `cdn03.ciceksepeti.com`).

Üçü birden yoksa tarayıcı yolu yoktur. Bu oturumda diğer 7 platformda 3. madde hiçbir
sayfa türünde (arama, SEO, marka, kategori, sitemap, ana sayfa) bulunamadı.

## Oturum 2026-10-12 (3. oturum)

### n11
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| Tarayıcı cross-origin `/arama?q=` | SSR JSON-LD ItemList (20 ürün, ad/fiyat/görsel/URL/stok — normal ziyarette görüldü) | Başarısız | CORS başlığı yok |
| Tarayıcı cross-origin sitemap index | sitemap | Başarısız | CORS yok |
| Sunucu, dürüst UA (curl) `/arama?q=Adidas+Samba` | aynı HTML | 200, JSON-LD 3 blok | — |
| Sunucu, dürüst UA (Node fetch) aynı yol, başka sorgu | aynı | **403** → durduruldu | İstemciye göre filtreleme (tahmin) |
- Alternatif: n11 iş ortaklığı / veri anlaşması; influencer programı (üçüncü taraf kaynak, resmî doğrulanmadı).
- Sonraki adım: n11'e resmî başvuru. **Tekrarlanmayacak:** sunucudan arama isteği (403 sonrası farklı istemci seçmek engeli dolanmak olur).

### PTTAVM
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| robots.txt | — | `Disallow: *?q=*` | Arama yasak |
| Normal ziyaret `/arama?q=` (yapı incelemesi) | SSR JSON-LD ItemList; Cloudflare challenge betiği | Yapı görüldü, otomasyon yok | robots |
| Tarayıcı cross-origin marka sayfası `/adidas` (robots izinli) | — | Başarısız | CORS yok |
| Sunucu, dürüst UA, `/adidas` | — | **403** Cloudflare | Bot koruması |
| Sitemap index (normal ziyaret) | 546 sitemap: kampanya, kategori, mağaza, marka, marka-kategori | Okundu | — |
- Alternatif: sitemap'ler katalog (canlı değil) için aday, ama sunucu 403 aldığı için sitemap'lerin sunucudan okunması **test edilmedi**.
- Sonraki adım: `static.pttavm.com` sitemap'lerinin sunucudan erişimi (ayrı alan adı, tek istek); PTT AVM ile resmî görüşme.

### Pazarama
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| robots.txt | — | `/arama`, `/search` yasak | — |
| Normal ziyaret arama (yapı) | Nuxt; sonuçlar `bff.pazarama.com/v2/search/<q>` XHR | Yapı görüldü | robots: arama otomasyonu yok |
| Tarayıcı cross-origin ana sayfa | — | Başarısız | CORS yok |
| Sunucu, dürüst UA, marka sitemap'i | `sitemaps/markalar/sitemap_0.xml` | **200, 5,1 MB** | — |
- `bff.pazarama.com` belgelenmemiş dahili API; CORS'u bilerek test edilmedi (kullanım koşulları belirsiz, robots `/developer/*` yasak).
- Sonraki adım: ürün sitemap'i (`sitemaps/urunler`) sunucudan okunabiliyor mu ve ürün sayfası SSR JSON-LD taşıyor mu (katalog yolu, canlı değil). Influencer/affiliate programı resmî kaynaktan doğrulanmalı.

### Amazon Türkiye
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| Tarayıcı cross-origin `/s?k=` | HTML kartlar (55), JSON-LD yok | Başarısız | CORS yok |
| Tarayıcı cross-origin `/gp/bestsellers` | — | Başarısız | CORS yok |
| Sunucu, dürüst UA, robots.txt | — | 200 | — |
| Resmî API araştırması | Creators API (PA-API'nin yerine), TR yereli: `tr_TR`, `TRY`; kayıt `gelirortakligi.amazon.com.tr` | Belgede var, **test edilmedi** | Kimlik bilgisi yok |
- En güçlü izinli aday: Creators API `SearchItems` (anahtar sözcükle canlı arama, fiyat, görsel, URL, affiliate etiketi). Ücretsiz ama Ortaklık hesabı ve satış şartı gerektirebilir.
- Sonraki adım: kullanıcı Ortaklık hesabı açarsa sandbox/test çağrısı; kullanım şartlarındaki önbellek/gösterim kuralları okunmalı.

### Letgo
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| robots.txt | — | `/arama?*`, `query_text`, `isSearchCall` yasak | — |
| Gerçek arama URL'si (sitenin arama kutusu) | `/arama?query_text=…&isSearchCall=true` | Bulundu | robots yasaklıyor |
| SEO arama sayfaları (sitemap-search-categories, 2.192 sayfa, ör. `/ikinci-el-samsung`) | robots izinli | Tarayıcı cross-origin başarısız (CORS yok) | — |
| Sunucu, dürüst UA, `/ikinci-el-playstation-5` | — | 200 ama Akamai `bm-verify` JS doğrulaması | Bot koruması → durduruldu |
- Sonraki adım: yok (teknik yol kapalı). Letgo ile veri anlaşması.

### Sahibinden
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| robots.txt | — | `/arama?`, `/search_result.php*` yasak | — |
| Normal ziyaret arama | — | `/cs/tloading` doğrulama ara sayfası | Bot koruması → durduruldu |
| Sunucu, dürüst UA, robots.txt | — | **403** | Bot koruması |
- Sonraki adım: yok. Sahibinden'in kurumsal/ilan API'si varsa resmî başvuru.

### Dolap
| Denenen | Kaynak | Sonuç | Neden |
|---|---|---|---|
| robots.txt | — | `/arama?`, `/api/` yasak | — |
| Tarayıcı cross-origin marka sayfası `/adidas` (robots izinli) | — | Başarısız | CORS yok |
| Sunucu, dürüst UA (curl) `/adidas` | Next.js RSC `initialProducts` (20 ilan: başlık, fiyat, görsel, durum) + JSON-LD CollectionPage | **200** | — |
| Sunucu, dürüst UA (curl) sitemap: kategoriler (112), marka-kategori (49) | sitemap | 200 | — |
| Sunucu, dürüst UA (Node fetch) `/kadin-elbise` | — | **403** → durduruldu | İstemciye göre filtreleme (tahmin) |
- Hipotez (doğrulanmadı): sorgu → SEO sayfası eşlemesi (marka/kategori sitemap'i) + `initialProducts` = yarı canlı keşif. Serbest metin araması değil.
- Sonraki adım: Dolap (Trendyol grubu) ile resmî görüşme. **Tekrarlanmayacak:** sunucudan sayfa isteği.

### Prototip canlı doğrulaması (HB + ÇS, 6 sorgu, 6 kategori)

`packages/core/src/live-search-browser/` mantığı tarayıcıya elle aktarıldı (paket çıktısının
eşdeğeri) ve example.com'dan çalıştırıldı (`mode:"cors"`, `credentials:"omit"`, istekler arası 3 sn).
"Eşleşen" = katı başlık eşleştirmesinden geçen; görsel = `Image()` ile gerçekten yüklendi.

| Sorgu | Hepsiburada (sayfa / eşleşen) | ÇiçekSepeti (sayfa / eşleşen) |
|---|---|---|
| iPhone 16 Pro 128 GB | 3 / 3 — Apple iPhone 16 Pro 128GB Çöl Titanyum, 130.000,00 TL | 30 / **0** (iPhone 17 vb. elendi) |
| Adidas Samba | 36 / 3 — adidas Samba OG FA24, 1.750,00 TL | 30 / 3 — Adidas Samba XLG, 2.199,00 TL |
| Siyah kadın elbise | 36 / 3 — 1.399,00 TL | 30 / 3 — 949,90 TL |
| Sony WH-1000XM5 | 25 / 3 — 15.749,00 TL | 30 / **0** (kulaklık pedleri elendi) |
| PlayStation 5 | 36 / 3 — PS5 Slim Digital + şarj istasyonu, 46.900,00 TL | 30 / 3 — PS5 Slim + 2. kol, 49.999,00 TL |
| Lego Technic | 36 / 3 — 42233, 289,00 TL | 30 / 3 — 42231, 6.339,18 TL |

Tüm ilk sonuçlarda görsel yüklendi, ürün URL'si doğrudan ürün sayfası. HB stok `in_stock`;
ÇS stok bilinmiyor. Gözlemler: paket ürünler ("+ şarj istasyonu", "+ 2. kol") eşleşmeden geçiyor;
bazı fiyatlar olağan dışı (HB Lego 289 TL, ÇS Samba %58 indirimli) — liste fiyatı ürün sayfasıyla
**karşılaştırılmadı**.

## Henüz test edilmemiş hipotezler (öncelik sırası, 5. oturum sonu)

1. **Amazon Creators API** `SearchItems` — kullanıcı Ortaklık hesabı + kimlik bilgisi sağlarsa ilk iş.
   Önce TR "Associates Program IP License" sayfası okunmalı (fiyat/zaman damgası gösterim kuralları).
2. **Eşleştirme:** çoklu uyumluluk aksesuarı kuralı (başlıkta ≥3 model kodu); ÇS için
   "iPhone 16 Pro" / "Sony XM5" sorgularında doğru ürün sayfada yok mu, yoksa sıralama mı (sayfa 2?).
3. **HB / ÇS farklı ağ:** kullanıcı mobil hatta harness'i açar; aynı 8 sorgu.
4. **Pazarama barkod hedefli fiyat:** bilinen bir EAN için `/-p-<EAN>` doğru ürüne gidiyor mu
   (tek istek, robots izinli). Katalog barkoduyla eşleştirme için.
5. **Icecat (Open Icecat)** ücretsiz katalog — TR kapsamı, görsel lisansı (fiyat yok).
6. **Affiliate ağları:** Admitad / Gelir Ortakları / ReklamAction resmî advertiser listelerinde
   n11, Pazarama, PTTAVM var mı; yayıncı ürün feed'i sunuluyor mu.
7. Sahibinden / n11 / Letgo / Dolap / Pazarama / PTTAVM ile veri ortaklığı görüşmesi (iş geliştirme).

Tamamlananlar (5. oturum): HB/ÇS fiyat çapraz kontrolü (6/6), Lego 289 TL açıklaması, eşleşme
değerlendirmesi ve düzeltmeleri, görsel yükleme, aynı ağda kararlılık, Creators API belge incelemesi,
Pazarama ürün sitemap'i ve ürün sayfası yapısı.

## Tekrar edilmeyecek testler

- 7 platformda tarayıcı cross-origin (arama, SEO, marka, sitemap, ana sayfa): hepsi CORS'suz.
- Robots'un yasakladığı arama yollarında otomasyon (PTTAVM, Pazarama, Letgo, Sahibinden, Dolap).
- 403/doğrulama alınan sunucu istekleri (n11, PTTAVM, Letgo, Sahibinden, Dolap): farklı istemci/başlık denemek yok.
- `bff.pazarama.com`, `mobileapi.n11.com`, `cs-web.ciceksepeti.com` gibi belgelenmemiş dahili API'ler.

## Oturum 2026-10-12 (4. oturum; ara verildi, aynı gün 5. oturumda sürdü)

- **Aşama 1.1 tamam:** Gerçek esbuild paketi (`live-search.js`, sha256 `dc25d151…b298`)
  `http://127.0.0.1:4599` kökeninden (ManiCepte benzeri farklı köken) yüklendi ve çalıştı.
  HB "Lego Technic": 36 sayfa / 5 eşleşen (42233 289 TL, John Deere 579 TL, Koenigsegg 3.199 TL,
  Ferrari FXX K 2.999 TL, Ford Bronco 2.999 TL). ÇS "Adidas Samba": 30 / 5 (2.199–2.349 TL).
  Harness scratchpad'de (repo dışı): `index.html`, `serve.mjs`, paket.

## Oturum 2026-10-12 (5. oturum)

### Aşama 1 — çalışan sistem (HB + ÇS)

**1.2 Fiyat çapraz kontrolü (6/6 tutarlı).** Liste fiyatı ↔ ürün sayfası. HB ürün sayfası da
cross-origin okunabiliyor (ACAO `*`); ÇS ürün sayfası CORS'suz, normal ziyaretle okundu.

| Ürün | Liste | Ürün sayfası (JSON-LD / ekranda) |
|---|---|---|
| HB iPhone 16 Pro 128GB Çöl Titanyum | 130.000,00 | JSON-LD `130000.00` (sayfadaki 119.499 vb. = diğer renk varyantları) |
| HB LEGO Technic 42233 | 289,00 | `289.00` / ekranda 289,00 TL |
| HB Sony WH-1000XM5 Gümüş | 15.749,00 | `15749.00` / ekranda 15.749,00 (15.489 = başka satıcı) |
| ÇS Adidas Samba XLG | 2.199,00 | `2199.00` / ekranda 2.199,00 (üstü çizili 5.199,00) |
| ÇS LEGO 42231 Dodge Charger | 6.339,18 | `6339.18` / ekranda 6.339,18 |
| ÇS LEGO 30710 Skid-Steer | 442,74 | `442.74` / ekranda 442,74 (52 parça) |

**1.3 "Lego Technic 289 TL" açıklandı:** 42233 *44 parçalık* küçük set; fiyat ürün sayfasıyla
aynı. Veri hatası değil. ÇS 30710 de 52 parçalık küçük set. Fiyat düşüklüğü tek başına şüphe
nedeni değil; ürün adı/parça sayısı bağlamı gösterilmeli.

**1.4 Eşleşme değerlendirmesi (8 sorgu × 2 mağaza, sınırsız liste).** Bulunan hatalar ve kurallar
(`match.ts`, hepsi regresyon testinde):
- "Sony WH-1000XM5" → "Sony Ult Wear … WH-1000XM5 ile Aynı İşlemci" → model kodu ilk 6 sözcükte olmalı.
- "PlayStation 5" → oyun ("EA SPORTS FC 27 Playstation 5 Fiziki"), kol ("Controller"), şarj
  istasyonu → `controller/gamepad/joystick/kumanda/fiziki` tam sözcük, `sarj` kök.
- "Dyson V15" → filtre, batarya, boru, hazne, başlık(ğı), fırça, emici → yedek parça kökleri.
- Paketler ("PS5 Slim + 2. kol") korunur; aksesuar kontrolü yalnızca `+` öncesinde; `isBundleTitle`
  arayüzde "paket" etiketi için.
- ÇS "PlayStation 5 … (İKİNCİ EL)" → durum sözcükleri (ikinci, yenilenmiş, teşhir, outlet,
  kullanılmış) sorguda yoksa elenir.
- **Gerileme yakalandı ve düzeltildi:** ilk düzeltmede "kol" aksesuar sayılınca giyimde "Balon Kol",
  "Sıfır Kol" elbiseleri; "mini" varyant sayılınca "Mini Elbise" eleniyordu (ÇS elbise 25 → 20).
  "kol" listeden çıkarıldı; varyant kuralı yalnızca rakam içeren (model) sorgularda (ÇS 20 → 29).
- Türkçe yumuşama: kök `basli` ("başlık"/"başlığı").

Sonuç tablosu (3. tur, son paket öncesi; satır = sayfadaki / eşleşen):

| Sorgu | HB | ÇS |
|---|---|---|
| iPhone 16 Pro 128 GB | 3/3 | 30/0 |
| Adidas Samba | 36/35 | 30/30 |
| Siyah kadın elbise | 36/8 | 30/29 |
| Sony WH-1000XM5 | 25/13 | 30/0 |
| PlayStation 5 | 36/17 (12 paket) | 30/11 (1 paket) |
| Lego Technic | 36/35 | 30/29 |
| iPhone 13 128 GB | 36/10 | 30/0 |
| Dyson V15 | 36/9 → parça kuralıyla azalır | 30/1 |

Son paket (`5f99b390…`) ile 4. tur: Dyson V15 HB 36/**4** (9'dan indi; tümü görsel yüklendi),
ÇS 30/0; PS5 HB 36/17, ÇS 30/**2** (ikinci el elendi; 11'den indi); elbise HB 36/8, ÇS 30/29.
**Kalan bilinen hata:** HB Dyson'da "V15s, V15, V11, V10 ve V8 İçin Çok Yönlü Temizlik Seti" ve
"… Mobilya …" gibi çoklu uyumluluk aksesuarları (2/4). "için"i aksesuar saymak Lego'yu bozar
("Çocuklar için"); sonraki hipotez: başlıkta ≥3 farklı model kodu = uyumluluk listesi.

**1.5 Kararlılık.** Aynı gün 4 tur (≈ 50 istek/mağaza), tüm isteklerde HTTP 200, CORS okundu, hiç
engel/doğrulama sayfası yok. Süre: HB 1–2,6 sn, ÇS 0,1–0,5 sn. **Ölçülemeyen:** farklı ağ (mobil
hat) ve farklı tarayıcı profili/gizli pencere — eklenti yalnızca mevcut profili sürer. Kullanıcı
mobil hatta harness'i açarak ölçebilir.

**1.6 Görsel/bağlantı.** 2. turda eşleşen tüm ürünlerin görselleri `Image()` ile yüklendi
(ör. HB Samba 35/35, ÇS Samba 30/30, HB PS5 23/23). Ürün URL'leri doğrudan ürün sayfası; 6
örnekte sayfa başlığı (h1) liste başlığıyla aynı.

### Aşama 2 — Amazon Creators API (belge okundu, test edilmedi)

Kaynak: affiliate-program.amazon.com/creatorsapi/docs (15 sayfa, 200).
- **Türkiye destekli:** marketplace `www.amazon.com.tr`, bölge EU, `tr_TR`, `TRY`; uç nokta
  `https://creatorsapi.amazon` `POST /catalog/v1/searchItems`; OAuth2 client credentials
  (EU, sürüm 3.2, `api.amazon.co.uk/auth/o2/token`, `scope: creatorsapi::default`, 1 saatlik token).
- **Arama:** `keywords` serbest metin; istek başına ≤10 ürün, ≤10 sayfa (≤100 sonuç); `searchIndex`,
  `minPrice/maxPrice`, `availability`, `condition` filtreleri.
- **Alanlar:** `offersV2.listings[].price.money`, `availability.type`, `merchantInfo.name`,
  `images.primary.*`, `detailPageURL` (etiketli). Yalnızca öne çıkan (buy box) teklif.
- **Erişim şartı:** TR Ortaklık hesabı (`gelirortakligi.amazon.com.tr`), **nihai kabul** ve
  **yönlendirilmiş nitelikli satış**; 30 gün satış yoksa erişim kapanır. Sayı belgede yok.
- **Ücret:** belgede ücret yok. Başlangıç 1 TPS / 8.640 TPD; gelire göre artar (≤10 TPS).
- **Kurallar:** Offers 1 saat, diğerleri 1 gün önbellek; bağlantılar değiştirilmez; `violatesMAP`
  ise fiyat gösterilmez; gizli anahtar istemci koduna konmaz (sunucu tarafı gerekir → CLAUDE.md
  kural 1/9 için ayrı karar). TR IP lisansı sayfası (fiyat/zaman damgası kuralları) **okunmadı**.
- **Kullanıcının yapması gerekenler:** (1) `gelirortakligi.amazon.com.tr`'de Ortaklık hesabı,
  (2) site/uygulama beyanı ve nihai kabul, (3) bağlantılarla nitelikli satış, (4) Associates
  Central → Tools → Creators API → Create Application, (5) Credential ID/Secret'ı güvenli kanaldan
  sunucu ortam değişkenine koymak (sohbete yapıştırmadan).

### Aşama 3 — Pazarama ve PTTAVM

- **Pazarama ürün sitemap'i** (sunucu, dürüst UA, curl): index 200 (320 sitemap); `sitemap_0.xml`
  200, 8,1 MB, **49.500 URL**, `lastmod` 2026-10-11 (günlük), `image:image` yok, URL'de ad yok
  (`/-p-<barkod>`; ör. 978… ISBN, 242… iç kod). Toplam ≈ 15,8 M ürün.
- **Pazarama ürün sayfası** (1 istek, 200): JSON-LD `Product` → ad, `offers.price` 247,19 TRY,
  `InStock`, `seller` "bkmkitap", görsel `img.pzrmcdn.com`. robots ürün yolunu yasaklamıyor.
- Değerlendirme: **canlı serbest metin araması değil** (URL'de ad yok, arama yolu robots'ta yasak).
  Katalog için her ürün sayfasını okumak gerekir → CLAUDE.md "scraping birincil kaynak olamaz".
  Tek meşru kullanım: barkodu bilinen ürün için `/-p-<barkod>` hedefli fiyat sorgusu
  (**hipotez, test edilmedi**: barkod yönlendirmesi her üründe geçerli mi?).
- **PTTAVM:** `static.pttavm.com/sitemap_index.xml` sunucudan 200; 497 ürün sitemap'i
  `www.pttavm.com/sitemaps/...` altında. `www` sunucudan Cloudflare 403 aldığı için **denenmedi**
  (tekrar edilmeyecek). Tarayıcıda normal ziyaretle okunabiliyor ama bu bir sunucu hattı değil.

### Aşama 4 — diğer platformlar, resmî/üçüncü taraf kaynaklar

- **Sahibinden:** resmî API var ama yalnızca API sözleşmesi imzalamış firmalara ve kurumsal
  mağazanın **kendi** ilanları için (yardım merkezi: "Kurumsal Emlak ve Vasıta Mağazalarına Sunulan
  Veri Transferi Yöntemleri"; Rekabet Kurulu 2025 kararı veri taşıma). Arama/keşif API'si değil.
- **n11, Letgo, Dolap:** resmî açık ürün arama API'si bulunamadı; n11 API'si satıcı paneli.
- **Akakçe / Cimri / Epey:** resmî API veya veri ortaklığı sayfası bulunamadı; yalnızca resmî
  olmayan kazıyıcılar (Apify) — kullanılmaz.
- **Affiliate ağları (Admitad vb.):** TR pazaryerleri için yayıncı ürün feed'i bilgisi bulunamadı.
- **Icecat:** aranmadı (sonraki oturum).


## Oturum 2026-10-12 (6. oturum) — Pazarama keşfi, Dyson, Amazon şartları

### Pazarama: çalışan yöntem (sunucu tarafı, gerçek ürünle doğrulandı)

Pazarama sayfaları CORS'suz → tarayıcıdan okunamaz; **yalnızca sunucu tarafı**. Dürüst UA,
3 sn aralık, 403/429'da durma. Bu oturumda Node `fetch` ve curl ile ~45 istek: hiç 403/429 yok.
Prototip: `packages/core/src/pazarama-discovery/` + `packages/core/scripts/pazarama-discover.ts`.

**H1 — Sitemap URL'sinden kimlik/metadata (kısmen):** ürün sitemap'i (320 × ~49.500) yalnızca
`/-p-<id>` + `lastmod` verir; ad/kategori/görsel yok. `<id>` çoğunlukla barkod (Apple UPC
`1959498…`, Sony EAN `4548736…`, ISBN `978…`), bazen iç kod (`pz…`, `TYB…`, `040400`).

**H2 — Kategori/özellik bölümleri (EVET):** `sitemaps/marka-ve-kategoriler` (8 dosya, ~435 bin yol,
ör. `/adidas/erkek-sneaker-ayakkabi-k-K02021`) ve `sitemaps/kategori-ve-filtreler` (9 dosya,
~400 bin yol, ör. `/kilif-k-K03028?model=iphone-16-pro`). Toplam 788.534 yol; robots yasaklamıyor,
`?sayfa=` açıkça izinli. Bu sayfalar ürün kartlarını **SSR** verir (sayfa başına 19–30 kart:
başlık, iki fiyat [liste, satış], `img.pzrmcdn.com` görsel, `-p-<barkod>` URL). Yalnızca YOL dizini
saklanır (ürün verisi değil); kartlar sorgu anında okunur.

**H3 — Barkod/GTIN ile URL (EVET):** `/-p-<barkod>` kanonik ürün sayfasına 301 ile gider
(`0195949771569` → `/apple-iphone-16-pro-128-gb-col-titanyum-p-195949771569`). Bilinmeyen barkod 404.

**H4/H8 — Başka kaynaktan barkod (EVET, mevcut altyapı):** Hepsiburada ürün sayfası (CORS açık)
JSON-LD/state içinde `gtin` verir. Zincir: sorgu → HB canlı arama (tarayıcı) → HB ürün sayfası `gtin`
(tarayıcı) → Pazarama `/-p-<gtin>` (sunucu; sunucuya kullanıcı sorgusu değil yalnızca barkod gider).
HB'den 16 ürün → 13 GTIN; 2'si uydurma (`0000…`) → reddedilir; 15 haneli → geçersiz.

**H6 — Tam tarama yapmadan keşif (EVET, iki yol):** (a) barkod zinciri, (b) sorgu → marka+kategori
yolu (`brandCategoryCandidates`: sorgunun dizinde markası olan ilk sözcüğü + kategori ipucu;
takma ad `iphone→apple`; marka sözcüğü puanlanmaz; "yenilenmiş/teşhir" kategorileri atlanır).
Açık sorun: kategori ipucu (`cep telefonu`, `kulaklik`, `sneaker`) şimdilik çağıran tarafından
veriliyor → mevcut ManiCepte kategori sınıflandırması / lexicon ile beslenmeli (test edilmedi).

**H7 — Bilinen bağlantıda fiyat (EVET, ama kart fiyatı GÜVENİLMEZ):** ürün sayfası JSON-LD
`Product.offers` (fiyat, TRY, stok, satıcı adı). Kart fiyatı ↔ ürün sayfası: 3 kartın **2'si
ürün sayfasında stoksuz** (Sony XM5 16.900 TL kartı; Nike DD8959 kartı — tarayıcıda da "tükendi").
Ayrıca stoksuz ürün sayfalarında eski fiyat duruyor (iPhone Çöl Titanyum 76.499 TL). Kural:
yalnızca ürün sayfasında `InStock` + fiyat varsa göster, fiyatı ürün sayfasından al (`verifyCards`).
Maliyet: sorgu başına SEO 1–4 + doğrulama ≤3 istek.

**Gerçek test (son çalıştırma, doğrulanmış = ürün sayfasında stokta + fiyatlı):**

| Sorgu | Barkod yolu | SEO yolu (kart → doğrulanan) | Doğrulanmış ürün |
|---|---|---|---|
| iPhone 16 Pro 128 GB | 3 GTIN → 1 stokta: Siyah Titanyum 126.500 TL (Akarsu İletişim) | `/apple/cep-telefonu` 2 sayfa → 0 kart (16 Pro 128 yok) | **1** |
| Adidas Samba | 1 GTIN → SAMBA OG B75807 5.499,08 TL (Korayspor) | 2 kart → 2: B75807 4.799,40 TL (Northsport), IG9030 W 4.499,10 TL | **3** |
| Sony WH-1000XM5 | 2 EAN → ikisi stoksuz | `/sony/kulaklik` + `/sony/bluetooth-kulaklik` → 2 kart → 0 (stoksuz) | **0** |
| Nike Air Force 1 | HB GTIN'leri 404 | `/nike/erkek-sneaker` + `/kadin-sneaker` → 2 → 2: 3.289,06 TL, 3.759,06 TL (UWİST) | **2** |

Toplam **6 doğrulanmış gerçek ürün**, hepsinde ad, fiyat (ürün sayfasından), satıcı, görsel, URL.

**Kullanım koşulları:** Pazarama kullanım şartları **okunmadı/doğrulanmadı**. Sitemap ve robots izni
ticari kullanım izni değildir. CLAUDE.md "scraping birincil kaynak olamaz" + kural 8 (click) +
istek yolunda dış sunucu çağrısı için ayrı ADR ve hukuki onay gerekir.

### PTTAVM
Pazarama yöntemleri teknik olarak uygun olurdu (`static.pttavm.com` index → 497 ürün sitemap'i, 39
marka-kategori sitemap'i), ama tüm sayfalar ve sitemap dosyaları `www.pttavm.com` altında ve
sunucu isteği Cloudflare 403 (3. oturum), tarayıcıdan CORS yok. **Tekrar denenmedi.** Yol: resmî görüşme.

### n11, Letgo, Sahibinden, Dolap
Belgelenmiş izinli bir arama/ürün kanalı bulunamadı (3.–5. oturum araması). Sahibinden'in resmî
API'si yalnızca sözleşmeli kurumsal mağazaların kendi ilanları için. n11 için 403 alınan istemci
yöntemleri tekrarlanmadı. Yeni test yapılmadı.

### Amazon TR — resmî şartlar (gelirortakligi.amazon.com.tr, policies/ ve agreement/ okundu)
- API kaydı: nihai kabul + yönlendirilmiş nitelikli satış (sayı API için belirtilmemiş); hesap
  incelemesi için "ilk 180 gün içinde en az üç satış", kişisel siparişler sayılmaz.
- Site şartı: orijinal içerik, en az 10 gönderi (son 60 gün), site sahibi olmak; ret sonrası yeniden
  inceleme yok. Gizlilik politikası (KVKK 6698) ve açıklama metni ("Amazon Associate olarak, uygun
  satın alımlardan kazanç sağlıyorum").
- Fiyat gösterimi: saatte bir yenilenmiyorsa zaman damgası ("… itibarıyla") + sabit sorumluluk metni.
- **Kritik:** §1(z) Program içeriği başka perakendecilerin ürünlerini tanıtmak için kullanılamaz;
  §2(c)(i) sitenin ana amacı Amazon'un reklamı olmalı; karşılaştırma formatı ancak en düşük yeni +
  kullanılmış Amazon fiyatı gösterilirse; görsel önbelleği yasak (bağlantı 24 saat); tarayıcı
  eklentisinde kullanım yasak; fiyat takip/uyarı işlevi yasak (§1(y)). ManiCepte'nin çok mağazalı
  karşılaştırma modeliyle uyumu **hukuki inceleme gerektirir**.

### Hepsiburada/ÇiçekSepeti — Dyson düzeltmesi
`match.ts`: sorgudaki harfle başlayan model kodunun ailesinden (`v15`→`v`) başlıkta ≥3 farklı kod
varsa uyumluluk aksesuarı. Rakamla başlayan kodlar (iPhone `16`, `128gb`, `5g`) kurala girmez.
Canlı (paket `5601c779…`): HB "Dyson V15" 36 → **2** (iki V15 Detect Absolute süpürge, 40.899 /
40.950 TL); aksesuarlar elendi. Not: "V15s" ayrı model sayılır (katı model eşleşmesi).
Regresyon: 51 test (live-search-browser) + 12 (pazarama-discovery); core 1942/1942.

### Sonraki oturum öncelikleri
1. Kategori ipucunu otomatik üret: mevcut ManiCepte kategori sınıflandırması/lexicon → Pazarama
   kategori slug'ı eşlemesi (ör. "kulaklık" → `bluetooth-kulaklik`, `kulaklik`).
2. Barkod zincirini ÇiçekSepeti'ne de bağla (ÇS ürün sayfasında GTIN var mı? CORS'suz → test).
3. Pazarama kullanım koşulları ve robots dışı şartların okunması (hukuk).
4. SEO dizininin güncellenmesi: sitemap `lastmod` ile günlük fark alma (yalnızca yol).
5. PTTAVM/n11/Letgo/Sahibinden/Dolap: iş geliştirme (resmî veri anlaşması).

Tekrar edilmeyecek: Pazarama `/arama` ve `/search`; `www.pttavm.com` sunucu istekleri; n11 sunucu
isteği; kart fiyatını doğrulamadan göstermek.

## Oturum 2026-10-12 (7. oturum) — Pazarama Faz 2: otomatik kategori, barkod genişletme, birleşik keşif

### 1. Otomatik kategori (model çağrısı yok)
- **Mevcut kod incelendi:** `search/parse-query.ts` (lexicon, DB'den), `clarification/product-types.ts`
  yalnızca üst katalog kategorileri verir ("elektronik"); Pazarama'nın ince slug'larına
  ("bluetooth-kulaklik") yetmez. Gemini kullanımı CLAUDE.md kural 1'e yeni istisna (ADR) gerektirir
  → **kullanılmadı**.
- **HB kategori faseti** (`VerticalFilter` → `AllCategories.CategoryId`) yalnızca en üst düzey:
  Sony WH-1000XM5 için "Telefon", Dyson için "Ev Elektroniği" → yanıltıcı, kullanılmadı.
- **Çözüm (deterministik, aynı aramanın canlı kanıtı):** `buildEvidence` = sorgu sözcükleri (ağırlık 5)
  + HB/ÇS katı eşleşen başlıklar + ÇS `categoryTree` adları (ÇS ürünlerine `categoryNames` eklendi,
  arama sonucuna `pageCategoryNames`). `rankSeoPages`: Türkçe ek toleranslı (ilk 5 harf) kategori
  slug puanı; aksesuar/yedek parça ve durum (yenilenmiş/teşhir) kategorileri elenir; markasız sorguda
  kategori + sorguda geçen filtre değeri (`?renk=siyah`).
- **Canlı bulunan tuzak:** Pazarama'da "pro" (33 sayfa), "siyah" (3), "air" (4) ayrı MARKALARDIR. İlk
  sürüm iPhone sorgusunda "pro" markasını seçti (SEO sonucu boş). Düzeltme: sorgudaki marka sözcüğü
  ancak eşleşen başlıkların ilk sözcükleriyle tutarlıysa aday; ayrıca başlıklarda baskın marka
  (≥%60, ≥2 başlık; "Apple iPhone…" → apple); markasız kip; en yüksek puanlı aday kümesi seçilir.
- **Dizin yeniden üretilebilir:** `scripts/pazarama-seo-index.ts` (kategoriler + marka-ve-kategoriler +
  kategori-ve-filtreler). Çalıştırma: 21 istek, 61 sn, **792.174 tekil yol** (3.640 / 385.569 / 402.965).
  Yalnızca yol saklanır; ürün verisi yok.

### 2. Barkod zinciri
- **ÇiçekSepeti barkod VERMİYOR:** arama RSC ürünlerinde ve ürün sayfasında (normal ziyaret) GTIN/EAN/
  barcode yok; yalnızca `sku: kcm…`. Ürün sayfası ayrıca CORS'suz. → ÇS barkod kaynağı olamaz.
- **HB genişletildi:** `extractHepsiburadaGtins` ürünün `gtin`'i + aynı sayfadaki varyant `barcode`
  değerleri (diğer renkler/kapasiteler). Varyant doğrulaması Pazarama ürün sayfası başlığıyla
  (`matchesQuery`): canlıda iPhone 16 Pro **256 GB** varyant barkodu `title-mismatch` ile elendi.

### 3–4. Birleşik keşif ve fiyat doğruluğu (`pazarama-discovery/combined.ts`)
- A (barkod) ve B (SEO) aynı aramada; biri hata verirse diğeri sürer; 403/429'da ikisi de durur,
  o ana kadarki doğrulanmış sonuç korunur. Tekrarlar `-p-<kimlik>` ile birleşir (`via: barcode+seo`).
- Her sonuç Pazarama **ürün sayfasından**: ad (sorguyla katı eşleşme), fiyat (JSON-LD, yalnızca
  `InStock`), TRY, görsel, satıcı, stok, kanonik bağlantı. Liste kartı fiyatı hiçbir sonuca geçmez.
- Elenenler raporlanır: `out_of_stock`, `title-mismatch` (yanlış varyant/kapasite), stoksuz kart.

### 6. Teknik sağlamlaştırma
- `isAllowedPazaramaUrl`: yalnızca `https://www.pazarama.com`, kimlik bilgisi/port yok, robots.txt'in
  TÜM Disallow kuralları (arama, developer, refresh-token, isplus=1 …).
- Yönlendirmeler elle (en çok 3); her adım yeniden denetlenir; başka alan adına yönlendirme izlenmez (SSRF).
- Zaman aşımı, istekler arası bekleme, istek bütçesi, 403/429'da kalıcı durma; ürün saklanmaz.
- Harness sunucusu yalnızca 127.0.0.1, gövde ≤20 KB, alan uzunlukları sınırlı, tek uçuş.

### 7. Erişim ve hukuk
- robots.txt (tam metin okundu): ürün, marka/kategori sayfaları, `?sayfa=`, sitemap'ler serbest;
  `/arama`, `/search`, `/developer/*` yasak. Otomatik erişim robots açısından izinli.
- **Kullanım koşulları bulunamadı:** `/kullanim-kosullari`, `/uyelik-sozlesmesi` ana sayfaya düşüyor,
  `/sozlesmeler` istemci tarafı boş kabuk. Ticari kullanım/otomatik erişim/karşılaştırma hakkında yazılı
  hüküm yok → **izin doğrulanmadı**. Yayıncı API/feed/affiliate yok ("Pazarama ADS" reklam ürünü).
- Production'a bağlanmadı; bağlanmadan önce: Pazarama ile yazılı izin/veri anlaşması, ADR
  (istek yolunda dış sunucu çağrısı, kural 8 click, scraping kuralı), KVKK değerlendirmesi.

### 5. Gerçek tarayıcı testi (harness: `scripts/pazarama-live-server.ts`, 127.0.0.1:4600)
Tarayıcı: HB + ÇS canlı arama ve HB ürün sayfası GTIN'i (CORS açık). Sunucu: yalnızca Pazarama
(dürüst UA, 2 sn aralık, sorgu başına ≤16 istek, 12 sn zaman aşımı). Görsel = `Image()` ile gerçekten
yüklendi. Süreler: tarayıcı adımı / sunucu adımı. Sekme arka plandayken Chrome zamanlayıcıları ~1 dk'ya
kısıyor (ilk turlarda 57 sn boşluklar) → tarayıcı tarafında bekleme kaldırıldı, sekme görünür tutuldu.

Son tur (aynı gün, son kod; Samba/iPhone/Dyson faset düzeltmesinden sonra yeniden):

| Sorgu | SEO sayfaları (otomatik) | Barkod (denenen/sayfa) | Kart → doğrulanan | Doğrulanmış ürün (Pazarama ürün sayfasından) | Süre | Başarısızlık nedeni |
|---|---|---|---|---|---|---|
| iPhone 16 Pro 128 GB | `/apple/cep-telefonu` | 4/4 (2 stoksuz, 1 **256 GB varyant elendi**) | 0 → 0 | **1**: Siyah Titanyum 126.500 TL (Akarsu İletişim) — barkod | 3,9 / 16,3 sn | 16 Pro 128 GB SEO 1. sayfada yok |
| Adidas Samba | `/adidas/kadin-sneaker`, `/adidas/ayakkabilar` | 4/4 hepsi stoksuz | 0 → 0 | **0** | 2,7 / 18,8 sn | Barkodlar stoksuz; 1. sayfalarda Samba kartı yok (önceki oturumda vardı → stok değişiyor) |
| Nike Air Force 1 | `/nike/erkek-sneaker`, `/nike/kadin-sneaker` | 4/0 (404) | 2 → 2 | **2**: 3.289,06 / 3.759,06 TL (UWİST) | 3,3 / 14,2 sn | HB GTIN'leri Pazarama'da yok |
| Sony WH-1000XM5 | `/sony/bluetooth-kulaklik`, `/sony/kulaklik` | 0 (HB'de geçerli GTIN yok, 15 hane) | 2 → 2 | **2**: 16.900 / 16.999 TL (muae elektronik) | 3,8 / 7,3 sn | — |
| Siyah kadın elbise | `/gunluk-elbise?renk=siyah`, `/yazlik-elbise?renk=siyah` | 4/2 stoksuz | 5 → 4 | **4**: 325,50 – 548,61 TL | 4,0 / 22,5 sn | — |
| PlayStation 5 | `/sony/playstation-5-konsol`, `/sony/retro-oyun-konsollari` | 3/3 | 10 → 4 (+1 barkod=SEO birleşti) | **5**: 38.688 – 45.540 TL | 3,6 / 20,7 sn | — |
| Dyson V15 | `/dyson/supurge`, `/dyson/robot-supurge` | 2/2 stoksuz | 0 → 0 | **0** | 1,6 / 10,7 sn | Barkodlar stoksuz; 1. sayfada V15 yok |
| Lego Technic | `/lego-yapi-oyuncaklari?tema=technic`, `/oyuncak-arabalar` | 3/3 (2 stoksuz) | 1 → 1 | **2**: John Deere 683,07 TL (barkod), Jeep Wrangler 2.693,10 TL | 4,6 / 14,1 sn | — |

Toplam **16 doğrulanmış gerçek ürün**, 8 sorgunun 6'sında. Tüm sonuçlarda görsel yüklendi, bağlantı
kanonik Pazarama ürün sayfası, fiyat ürün sayfası JSON-LD'sinden (TRY, `InStock`), satıcı adı mevcut.
Liste kartı fiyatı hiçbir sonuca geçmedi. Hiç 403/429 yok.

Canlı turlarda bulunup düzeltilen seçim hataları (hepsi regresyon testinde): "pro"/"siyah"/"air"
marka tuzağı; eşleşmeyen ÇS ürünlerinden "Akıllı Saat"; `/sony-k-…` marka-kategori; "kadın takım
elbise"; `abiye-elbise?mevsim=elbise`; aynı kategorinin iki filtre varyantı; `playstation-4-konsol`;
`elektronova` (HB faset gürültüsü); "Spor / Outdoor" faseti → `outdoor-ayakkabi`; çocuk kategorisi.

### Sonraki adımlar
1. Barkod ve SEO boş kalırsa izinli `?sayfa=2` (bütçe: barkod 8 + SEO 4 + doğrulama 4).
2. Sorgu başına süre: sunucu adımı 7–29 sn (sıralı, 2 sn aralık, liste sayfası 2–3 MB). Üretim için
   paralellik değil, önbellek de değil (ürün saklanmaz) → kabul edilebilir mi, UX kararı.
3. Pazarama ile yazılı izin / veri anlaşması (koşullar sayfası yok); ADR taslağı.
4. `TYPE_MODIFIERS` ve aksesuar listeleri canlı gözlemle genişletilmeli (şimdilik yalnızca görülen).

## Oturum 2026-10-12 (8. oturum) — Pazarama Faz 3: kapsam, hız, doğruluk

### 1. İki başarısız sorgunun gerçek nedeni (tanı: `scripts/pazarama-diagnose.ts`)

**Dyson V15 — gerçek stok yokluğu DEĞİL, aşırı katı filtre.** Pazarama'da stokta V15 var
(`/dyson/sarjli-dikey-supurge` 1. sayfa: V15 Detect 36.377 TL, V15 Detect Absolute 44.521 /
35.719 TL). İki hata:
1. Eşleştirici "Şarjlı" sözcüğünü aksesuar kökü `sarj` ile yakalayıp ürünü eliyordu
   (`matchesQuery("Dyson V15 Detect Kablosuz Şarjlı Dikey Süpürge", "Dyson V15") = false`).
2. Kategori seçici de `sarjli-dikey-supurge` kategorisini aynı kökle aksesuar sayıyordu; ayrıca
   `?model=v15-detect` filtre sayfası "detect" sorguda olmadığı için reddediliyordu.

**Adidas Samba — yanlış sayfa sıralaması + ilk sayfa sınırı.** `/adidas/erkek-sneaker` 1. sayfada
3 Samba (B75807 4.799 TL, B75806, IG9030); seçici ise "erkek"i kanıtsız sözcük sayıp cezalandırdı ve
`/adidas/ayakkabilar`'ı seçti. `/adidas/kadin-sneaker`'da Samba ancak **3. sayfada**. Barkodlar
(HB GTIN'leri, beden barkodları) Pazarama'da stoksuz — bu kısım gerçek stok durumu.

Ek bulunan yanlış eşleşme: "adidas **Sambae** W" (ayrı model) Türkçe ek toleransıyla "Samba"
sayılıyordu.

### 1b. Düzeltmeler (hepsi regresyon testinde)
- `PRODUCT_ATTRIBUTE_WORDS/SLUGS`: "şarjlı/şarjsız" aksesuar değil (eşleştirici + seçici).
- Filtre değeri: sorgudan en az bir HARF sözcüğü içermeli; kalan sözcükler sorguda ya da eşleşen
  başlıklarda güçlü kanıtla (ağırlık ≥ 1) geçmeli → `?model=v15-detect-absolute` seçiliyor;
  yalnızca sayı eşleşmesi reddedilir (`Air Force 1` → `?bedenyas=1` seçilmişti).
- Cinsiyet sözcükleri (kadın/erkek/unisex) sorguda yoksa nötr → Samba için erkek + kadın sneaker.
- Baş isim kuralı: sorgunun son harfli sözcüğü dizinde kategori sözcüğüyse aday kategori onu içermeli
  (`Siyah kadın elbise` → `kadin-gomlek` seçilmişti).
- Filtre değerinde tekrar (`siyah-siyah`) tek sayılır; aynı temel kategoriden tek sayfa.
- Marka sayfaları + sorguyla eşleşen filtre sayfaları aynı listede yarışır (en çok 3 aday).
- Türkçe ek toleransı yalnızca gerçek eklerle (`-si, -leri, -ya…`): "Sambae" ≠ "Samba".

### 2. Performans: aşama ölçümü ve iyileştirmeler
- **Yerel dizin:** 792 bin yol her sorguda regex'le taranıyordu (~400 ms). `prepareSeoIndex`
  açılışta bir kez (~0,6–0,8 sn), markaya göre gruplu → eşleme **30–145 ms**.
- **İstemci:** slot tabanlı hız sınırı (istek BAŞLANGIÇLARI arası ≥ 1 sn; Faz 2'de 2 sn ve sıralı),
  barkod ve SEO yolları eşzamanlı; aynı URL bir arama içinde tekrar indirilmez (yönlendirme hedefi
  dahil); her istek süre/bayt ile loglanır.
- **Sayfalama:** robots `Allow: /*?sayfa`. Sıralı (round-robin): tüm adayların 1. sayfası HER ZAMAN
  okunur (ilk başarı diğer adayları elemez); hedef (4 doğrulanmış) dolduysa derin sayfaya inilmez.
- **Tarayıcı:** HB ve ÇS araması eşzamanlı; HB ürün sayfaları (GTIN) paralel (≤3).
- **Darboğaz (ölçülen):** liste sayfası 2,4–2,7 MB ve 1–2,5 sn; ürün sayfası ~0,5–0,9 MB. Sunucu
  süresinin çoğu bilinçli hız sınırı (1 istek/sn) × istek sayısı. Fiyat doğrulaması kaldırılmadı.

### 4. Hibrit mimari değerlendirmesi (bağlanmadı)
- Üç kaynak bağımsız: HB ve ÇS **ziyaretçi tarayıcısında** (CORS), Pazarama **sunucuda**.
- Önerilen akış: arama sayfası HB/ÇS sonuçlarını kendi `fetch`'leriyle akıtır (her kaynak kendi
  bölümünde, bekleme yok); HB/ÇS kanıtı (GTIN, eşleşen başlık, kategori) hazır olunca sunucuya
  **ayrı** bir istek gider; Pazarama bölümü ayrı bir yükleme durumuyla gelir. Yavaş kaynak diğerlerini
  bloke etmez; Pazarama hata/engel verirse bölüm sessizce boş kalır.
- Doğrulanmamış fiyat gösterilmez: HB/ÇS liste fiyatı (Faz 1'de 6/6 ürün sayfasıyla tutarlı) ve
  Pazarama ürün sayfası fiyatı; Pazarama liste kartı fiyatı hiçbir zaman.
- Sunucu tarafı yalnızca barkod + eşleşen başlık + kategori adı alır; ham sorgu metni de gider
  (SEO eşlemesi için) — KVKK değerlendirmesinde not edilmeli.
- Henüz sohbete/aramaya bağlanmadı; production için ADR + Pazarama izni şart.

### 5. Gerçek testler ve kıyaslama
**Uçtan uca (gerçek tarayıcı + harness, Faz 3 kodu, 1 tur):** 8/8 sorguda sonuç, **30 doğrulanmış
ürün** (önceki referans: 6/8 sorgu, 16 ürün). Tüm görseller `Image()` ile yüklendi. Tarayıcı adımı
(HB + ÇS eşzamanlı arama + paralel GTIN) 2,0–3,8 sn; sunucu adımı 11–23 sn. Bu turda bulunan
"Sambae" yanlış eşleşmesi düzeltildi.

**Pazarama aşaması kıyaslaması** (`scripts/pazarama-bench.ts`, tarayıcıdan kaydedilen aynı gerçek
kanıt, aynı gün, art arda; 403/429 yok). `faz2` = Faz 2 erişim stratejisi (sıralı, 2 sn aralık,
yalnız 1. sayfa, 2 aday, 4 doğrulama) — seçim/eşleştirme düzeltmeleri ikisinde de ortak.

| Yapılandırma | Tur | Doğrulanmış ürün/tur | Ortalama | Medyan | p95 | İstek/sorgu | İstek/ürün | Veri/sorgu |
|---|---|---|---|---|---|---|---|---|
| faz2 stratejisi | 1 | 17 | 16,3 sn | 16,5 sn | 22,3 sn | 9,0 | 4,2 | ~7 MB |
| **faz3** | 3 | **30** (3 turda aynı) | **14,6 sn** | **13,3 sn** | 22,3 sn | 15,3 | 4,1 | ~19 MB |

Sorgu bazında (faz3, tur 1): iPhone 1 (12 istek, 11,2 sn) · Samba 6 (23, 22,3) · Nike 6 (16, 15,2,
erken durdu) · Sony 3 (12, 11,3) · Siyah elbise 6 (15, 14,2, erken) · PS5 5 (13, 12,2, erken) ·
Dyson 1 (14, 13,3) · Lego 2 (17, 16,3). Turlar arası süre farkı ±%2.

Aşama ortalamaları (faz3, 24 koşu): eşleme 84 ms · barkod yolu 8,5 sn · SEO yolu 14,0 sn (ikisi
eşzamanlı) · liste indirme toplam 8,4 sn · ürün sayfası toplam 14,1 sn · birleştirme <1 ms ·
toplam 14,6 sn. Elenenler: 54 stoksuz, 3 yanlış varyant (iPhone 256 GB). Gösterilen sonuçlarda
yanlış model/aksesuar/kapasite yok (Samba 6, Dyson 1, Lego 2, Sony 3 başlık başlık denetlendi).

**Gecikmenin gerçek nedeni:** istek sayısı × bilinçli hız sınırı (1 istek/sn) + 2,6 MB'lık liste
sayfaları. Faz 3 daha çok sayfa okuduğu halde medyanda −%19 (eşzamanlı yollar + 1 sn slot); p95
değişmedi (Samba: 9 liste sayfası). Fiyat doğrulaması korunuyor; istek/ürün değişmedi (4,1–4,2).

### Kalan sorunlar / sonraki adımlar
1. Veri hacmi: liste sayfası 2,6 MB × ~6 → sorgu başına ~19 MB. Hedef dolunca durma zaten var;
   ek fikir: art arda iki boş sayfadan sonra o yolu bırakma (Samba kadın sneaker 3. sayfa örneği
   bunu riskli kılıyor — ölçülmeli).
2. Aynı model farklı beden kayıtları ayrı sonuç (ör. IG9030 W iki barkod, aynı satıcı/fiyat):
   başlık+satıcı+fiyat ile gruplanabilir.
3. Barkod yolunda her GTIN 2 istek (`/-p-<gtin>` 301 + kanonik); beden barkodları çoğunlukla
   stoksuz → ayakkabıda barkod yolunun verimi düşük.
4. Pazarama kullanım koşulları sayfası bulunamadı (7. oturum); ticari izin doğrulanmadı →
   production yok. Bağlanmadan önce: yazılı izin, ADR, KVKK.

## Oturum 2026-10-12 (9. oturum) — Pazarama Faz 4: istek analizi, veri ve gecikme

### 1. Ölçüm (Faz 3 davranışı, 3 tur, istemci logu: tür, bekleme, ağ süresi, bayt)
Sorgu başına ortalama 15,1 istek: **liste 6,1 · ürün detayı 3,9 · barkod 5,1**; açılmış veri 19,3 MB
(liste sayfası 2,55 MB, detay 0,54 MB). Hız sınırı slotlarında bekleme toplamı 17,8 sn (iki yol
eşzamanlı olduğundan duvar süresinden büyük), gerçek ağ süresi 4,5 sn. **Gecikmenin nedeni istek
sayısı × 1 sn hız sınırı**; ağ değil. Node `fetch` zaten Brotli ister (2,74 MB → 0,47 MB aktarım).

**Samba (p95):** 23 istek = 9 liste + 6 detay + **8 barkod (4 GTIN × yönlendirme; 4/4 stoksuz)**.
Eşleşmeler: erkek-sneaker s.1 (2) ve s.3 (2), kadın-sneaker s.3 (2); diğer 5 liste sayfası boş.

**Sayfalama analizi (eşleşen kart / kart):** Sony, Dyson, Lego'da 2.–3. sayfalar hep 0 eşleşme
(6'şar istek). Liste sayfası kendi ürün sayısını yazıyor: Sony bluetooth "9 ürün" (sayfada 19 kart),
Dyson filtre "2 ürün" (15 kart) → fazla kartlar öneri bloğu; sonraki sayfalar boşuna.
**Barkod yolu bu veri kümesinde hiçbir sonuca TEK BAŞINA katkı vermedi** (iPhone ve PS5 sonuçları
`barcode+seo`; SEO derin sayfada da buldu) ama ortalama 5,1 istek harcadı.

### 2–3. Optimizasyonlar
| # | Değişiklik | Gerekçe (ölçüm) |
|---|---|---|
| O1 | Akışla okuma + kesme: liste `window.__NUXT__`'tan önce (kartların tamamı ilk ~%12'de) | liste 2,55 MB → 0,23 MB |
| O2 | Ürün detayı: JSON-LD + fiyat bloğu + renk, Nuxt'tan önce (~195 KB; tam sayfa 570 KB) | Sepette/liste fiyatı ve renk için gerekli |
| O3 | Kimlik normalizasyonu (GTIN baştaki 0) + SEO'nun doğruladığı ürünün barkodunu isteme; hedef dolunca barkodu durdur | erken birleştirme |
| O4 | Liste sayfasının "N ürün" sayısından son sayfa: ⌈N/30⌉ sonrası istenmez | Sony/Dyson/Lego boş sayfalar |
| O5 | Barkod yolunda art arda 2 ıska (404/stoksuz/yanlış varyant) → kalan barkodlar istenmez | Samba 4/4 stoksuz |
Kural sağlanmazsa sayfa tam okunur (yapı değişirse veri kaybı yok). İstek sıklığı, robots, SSRF,
yönlendirme ve 403/429 durma kuralları değişmedi.

### 4. Fiyat ve varyant doğruluğu
- **Bulgu:** JSON-LD fiyatı Pazarama'nın **"Sepette" kampanya fiyatıdır** (Samba B75807: liste 7.999,00 TL,
  Sepette 4.799,40 TL = JSON-LD 4799.4). Sonuca `basketPrice: true` + `listPriceKurus` eklendi;
  arayüzde "Sepette fiyatı" etiketi şart. JSON-LD fiyatı sepet fiyatına eşit değilse etiket konmaz.
- Renk (`Renk` alanı), barkod (sayısal kimlik) sonuçta; **her barkod ayrı sonuç** (bedenler
  birleştirilmez; ör. IG9030 W iki barkod iki satır). Satıcı ve stok JSON-LD'den.
- Kesme doğrulaması: 3 gerçek ürün sayfasında kesilmiş okuma = tam okuma (aynı ayrıştırma sonucu).
- Bağımsız doğruluk denetimi (elle yazılmış model kalıpları, eşleştiriciden ayrı): tüm turlarda
  **0 yanlış eşleşme**; "Sambae" ve "V15s" kalıpla dışlanıyor.

### 5. Karşılaştırma (aynı gerçek kanıt, aynı gün, art arda, 3'er tur)
| Yapılandırma | Başarılı sorgu | Doğrulanmış ürün/tur | Yanlış | Ort. | Medyan | p95 | İstek/sorgu (L/D/B) | Veri/sorgu |
|---|---|---|---|---|---|---|---|---|
| faz3 (referans) | 8/8 | 32 | 0 | 14,6 sn | 13,8 sn | 22,3 sn | 15,1 (6,1/3,9/5,1) | 19,3 MB |
| faz4 (O1+O3, detay 11 KB) | 8/8 | 32 | 0 | 14,4 sn | 13,4 sn | 22,3 sn | 15,1 | 1,52 MB |
| **faz4b (O1+O3+O4+O5, detay 11 KB)** | 8/8 | 32 | 0 | **10,8 sn** | **11,2 sn** | **16,3 sn** | **11,4 (3,6/3,9/3,9)** | **1,07 MB** |
(Referans 32: 8. oturumdaki 30'dan fazlası stok/sıralama değişimi; ölçümler aynı kanıtla aynı gün.)
Sorgu bazında faz4b: Sony 12→6 istek, 11,3→5,3 sn; Dyson 14→8, 13,4→7,4 sn; Lego 17→9, 16,4→8,3 sn;
Samba 23→17, 22,3→16,3 sn (p95 kaynağı); kapsam her sorguda aynı.

**Son yapılandırma (O2 = detay ~195 KB) 3 turla ÖLÇÜLEMEDİ:** faz4b'nin hemen ardından başlayan koşunun
ilk sorgusunda Pazarama **HTTP 429** döndü; kural gereği durduruldu, tekrar denenmedi. 429, ~20 dk
boyunca kesintisiz ~1 istek/sn kıyaslama yükünün ardından geldi (tek tek aramalarda hiç görülmedi).
Son yapılandırma faz4b'den yalnızca detay sayfasında okunan veri miktarıyla ayrılır: **tahmin**
(ölçülmedi) ~+0,7 MB/sorgu (3,9 detay × ~180 KB) → ~1,8 MB/sorgu; istek sayısı aynı.

### Önemli: hız sınırı bulgusu ve sonraki adımlar
1. Pazarama sürekli ~1 istek/sn yükte 429 veriyor → üretimde kullanıcılar arası **ortak** (global)
   istek bütçesi gerekir; kıyaslamalar arasında soğuma süresi bırakılmalı. 429 sonrası bekleme süresi
   bilinmiyor; bu oturumda yeniden denenmedi.
2. Son yapılandırmanın 3 turluk ölçümü soğumadan sonra tekrar edilmeli.
3. Ticari kullanım izni doğrulanmadı (kullanım koşulları sayfası yok) → production yok.
4. Arayüz: "Sepette fiyatı" etiketi + üstü çizili liste fiyatı; beden/barkod satırları gruplanırsa
   da her barkodun ayrı fiyat/stoku korunmalı.

## Oturum 2026-10-12 (10. oturum) — Pazarama Faz 5: dayanıklılık (Pazarama'ya istek ATILMADI)

### 1. 429 analizi (mevcut kod)
- Hız sınırı **arama başına** (`PazaramaClient` slotu). N eşzamanlı kullanıcı = Pazarama'ya N kat hız;
  birden çok instance'da da aynı. Sunucu genelinde ortak sınır **yoktu**.
- 429/403 yalnızca o aramanın istemcisini durduruyordu; sonraki arama sıfırdan istek atıyordu.
- `Retry-After` okunmuyordu. Harness sunucusunda tek-uçuş kilidi vardı (2. kullanıcıya 429 dönüyordu).
- 9. oturumdaki 429: ~20 dk sürekli ~1 istek/sn → sorun anlık yük değil, sürekli bütçe.

### 2. Ortak istek yönetimi (`pazarama-discovery/host-gate.ts`)
`HostGate` (host başına; diğer mağazalar etkilenmez):
- **Hız:** istek başlangıçları arası `minIntervalMs` (1 sn) — tüm kullanıcılar için ortak slot.
- **Eşzamanlılık + kuyruk:** aynı anda en çok 2; fazlası FIFO kuyrukta (en çok 20); kuyruk doluysa ya da
  slot beklemesi > 10 sn ise istek **ağa gitmeden** reddedilir (`queue-full` / `wait-too-long`).
  Kapasite, kuyruktan uyandırılan istek adına uyandıran tarafından ayrılır (yarış yok).
- **Devre kesici:** 429/403 → açılır; `Retry-After` (saniye ya da HTTP tarihi, [1 sn, 24 sa]) yoksa 15 dk,
  art arda açılmada ikiye katlanır (tavan 6 sa). Süre dolunca **yarı açık: tek deneme isteği**; başarılı ise
  kapanır, ağ hatasıyla biterse deneme hakkı geri verilir (kilitlenme yok). Açılınca kuyruktakiler
  kapasite almadan reddedilir.
- **İki uygulama:** `InMemoryHostGate` (tek süreç) ve `RedisHostGate` (çok instance: slot ve devre Redis'te,
  tek Lua betiği, Redis saati `TIME`; `provider-budget.ts` deseniyle). **Redis'e ulaşılamazsa istek
  reddedilir** (`unavailable`): güvenilir dağıtık sınır yokken siteye istek atılmaz. Eşzamanlılık/kuyruk
  Redis uygulamasında instance içinde (toplam hız Redis slotuyla sınırlı).
- `PazaramaClient({ gate })`: kapı varsa kendi slotunu kullanmaz; ret = ağ isteği yok (`deniedBy`);
  429/403'te `Retry-After` ile `trip`, başarıda `succeed`; bilet her durumda `finally` ile bırakılır.
- Harness sunucusu tek ortak kapı kullanır (REDIS_URL varsa Redis); tek-uçuş kilidi kaldırıldı.

### 3. Fiyat güvenilirliği
`priceKind: "regular" | "basket"`, `regularPriceKurus`, `basketPriceKurus`, `basketConditionsVerified: false`
(sepet tutarı/kupon/süre gibi koşullar doğrulanmıyor; arayüz "Sepette fiyatı; koşullar mağazada" demeli).
JSON-LD fiyatı Sepette bloğundaki fiyata eşit değilse sepet etiketi konmaz. Her barkod ayrı sonuç;
satıcı, renk, fiyat kendi ürün sayfasından (test: aynı başlıklı iki barkod iki ayrı fiyat/satıcı/renk).

### 4. Performans
- `timings.firstResultMs` + `onResult(result, elapsedMs)`: ilk doğrulanmış ürün bulunduğu an bildirilir
  (arayüz tüm aramayı beklemeden gösterebilir). `pazarama-bench.ts` özetine ilk ürün medyan/p95 eklendi
  (canlı çalıştırılmadı).
- Tek kullanıcıda kapılı ve kapısız (Faz 4b) akış aynı: aynı istek sayısı, toplam süre, ilk ürün süresi
  (sanal saatli fixture testi). Faz 4b canlı referansı geçerli: ort. 10,8 sn, p95 16,3 sn, 11,4 istek,
  1,07 MB/sorgu.

### 5. Testler (ağ yok, deterministik sanal saat; Redis testleri yerel Docker Redis)
| Senaryo | Sonuç |
|---|---|
| 10 eşzamanlı arama | hepsi 2 sonuç; başlangıç aralığı ≥ 1 sn; aynı anda ≤ 2 istek; ilk ürün süresi ölçüldü |
| 50 eşzamanlı arama | bir kısmı `queue-full`/`wait-too-long` ile AĞA GİTMEDEN reddedildi; hız ve eşzamanlılık hiç aşılmadı |
| Kuyruk dolması | 1 hemen, 2 kuyrukta (0/1000/2000 ms), 2 anında `queue-full` |
| 429 + Retry-After 120 | 120 sn açık, bu sürede 0 ağ isteği; yarı açıkta tek deneme; başarıyla kapanma |
| Retry-After yok / tekrar 429 | 60 sn → 120 sn → tavan 150 sn |
| Zaman aşımı | istek düşer, bilet geri verilir, sıradaki akar |
| Kaynak hatası | barkod yolu tamamen çöküp SEO yolu 2 sonuç döndürür |
| Mağaza izolasyonu | Pazarama devresi açıkken başka host kabul edilir |
| Redis yok | `unavailable`, siteye 0 istek |
| Redis (gerçek, yerel) | iki instance ortak slot; `wait-too-long`; devre tüm instance'larda; geri çekilme; host izolasyonu (5/5) |
Toplam: core 1994/1994, Redis entegrasyon 5/5; typecheck/lint temiz.

### Kalan
- Ortak kapı yalnızca prototipte; production yok (ticari izin doğrulanmadı).
- Redis uygulamasında eşzamanlılık instance içinde; gerçek çok-instance eşzamanlılık sınırı (Redis semafor)
  gerekirse ayrıca.
- Son yapılandırmanın canlı 3 turu ve ilk ürün süresinin canlı ölçümü, soğumadan sonra ve izinle.

## Oturum 2026-10-12 (11. oturum) — Merkezi kapı: global eşzamanlılık (Pazarama'ya istek ATILMADI)

- `RedisHostGate` eşzamanlılığı artık **global**: `hostgate:<host>:leases` sıralı kümesinde kira (lease)
  semaforu. Tek Lua betiği (Redis `TIME`): devre kontrolü → yarı açık tek deneme (`probe` SET NX) →
  süresi dolmuş kiraları sil → kapasite kontrolü → hız slotu → kira ekle. Kapasite doluysa kod 3:
  istemci en erken kira bitişine / `pollMs`'ye kadar bekleyip yeniden dener; `maxWaitMs` aşılırsa ağa
  gitmeden `wait-too-long`. Instance başına bekleyen sayısı `maxQueue`.
- Kira süresi (`leaseMs`, varsayılan 20 sn) istek zaman aşımından (12 sn) büyük: süreç çökse/bilet
  bırakılamasa da kapasite kendiliğinden döner. Normal yolda bilet bırakılınca kira hemen silinir;
  ret/hata yollarında da iade edilir; iki kez bırakmak zararsız.
- Slot beklemesinden sonra devre yeniden kontrol edilir: başka instance 429 aldıysa istek atılmaz.
- 429/403, Retry-After, geri çekilme (ikiye katlama, tavan) korundu; yarı açık deneme TÜM instance'larda
  tek; deneme ağ hatasıyla biterse hak geri verilir. Redis yoksa `unavailable` (siteye istek yok).
- İlk ürün süresi: kapasite boşken istek başına tek Redis çağrısı, sıfır ek bekleme (birim testi).
- Eşleştirme, barkod, fiyat ve görsel mantığına dokunulmadı.
- Betiklerdeki bot iletişim bilgisi depodan çıkarıldı (`prototypeUserAgent()`, `MANICEPTE_BOT_CONTACT`).

Testler: core 1998/1998; yerel Redis entegrasyonu 9/9 — 4 instance × 10 eşzamanlı istekte aynı anda ≤ 2
ve başlangıç aralığı korunur; çöken instance'ın kirası düşer; tek deneme; beklerken açılan devre;
geri çekilme; host izolasyonu. Typecheck/lint temiz.

### Kalan teknik engeller
1. **Ticari kullanım izni** doğrulanmadı (Pazarama'da kullanım koşulları sayfası yok) → production yok.
2. **Canlı doğrulama yok:** son yapılandırmanın canlı 3 turu ve ilk ürün süresinin canlı ölçümü 429
   soğuması + izin sonrası yapılmalı.
3. **Vercel + Redis gecikmesi:** her istek için 1 Lua çağrısı (+ kira bırakma); Upstash/uzak Redis'te
   ~5–20 ms/istek ek gecikme ölçülmedi.
4. **Adalet:** kapasite doluyken instance'lar yoklama yapar (FIFO değil); yoğun yükte kuyruk sırası
   garanti değil.
5. **Bütçe:** 1 istek/sn global sınır, çok kullanıcıda arama başına ~11 istek → yaklaşık 5 eşzamanlı
   arama/dk üst sınırı; ölçeklenme için Pazarama ile resmî veri anlaşması gerekir.
