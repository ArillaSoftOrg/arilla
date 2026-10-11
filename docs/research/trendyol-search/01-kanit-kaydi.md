# Trendyol bağımsız ürün arama: kanıt kaydı

Her satır gerçekten yapılmış bir testtir. Tarih: 2026-10-12 (UTC+3).
İstemci kimliği her zaman dürüst: `ManiCepteBot-research/0.1 (+contact)`.
"Doğrulanmadı" yazan bilgi, kaynağı ikincil ya da çelişkili olduğu için
gerçek kabul edilmemelidir.

## Faz 0 — Önceki oturumlar (PR #124, #125, dal `research/live-search-extension`)

| # | Test | Sonuç | Kanıt |
|---|---|---|---|
| 0.1 | `robots.txt` (`User-agent: *`) | `/sr?`, `/sr/`, `/sr$`, `/*?q=` **yasak**; kategori (`-x-c`), marka (`-x-b`), ürün (`-p-`) sayfaları ve sitemap'ler serbest; `/*-x-*-a*-v*?pi=` yasak | robots.txt, 684 satır |
| 0.2 | `apigw.trendyol.com/robots.txt` | `Disallow: /` (dahili arama servisi botlara tamamen kapalı) | 200, 2 satır |
| 0.3 | Kullanım koşulları `/kullanim_kosullari` | Materyal "önceden izin alınmadan … kopyalanamaz, çoğaltılamaz, yeniden yayımlanamaz" | 200 |
| 0.4 | Node `fetch` → kategori sayfası | **403** (Cloudflare) | PR #125 |
| 0.5 | Node `fetch` → ürün sayfası | **403** `server: cloudflare` | bu oturum |
| 0.6 | curl → ürün sayfası | 200 (aynı UA) | teşhis amaçlı; istemci değiştirmek parmak izi atlatması sayılır, **üretim yöntemi olarak kullanılmadı** |
| 0.7 | Tarayıcı, başka origin'den `fetch(www.trendyol.com/...)` | CORS: `Failed to fetch` (arama sayfası ve ana sayfa) | example.com ve localhost'tan |
| 0.8 | Gerçek Chrome, `/sr?q=iPhone 16 Pro` | 36 ürün `window["__single-search-result__PROPS"]` içinde (ad, marka, fiyat metni, görsel, url, kategori); 19/36 aksesuar | eklenti prototipi |
| 0.9 | Kategori sayfası ilk sayfa | Yalnızca 36/189 ürün; `?pi=2` aynı sayfayı döndürdü | PR #125 |

## Faz 1 — Resmî / yetkili kanallar

| # | Kanal | Trendyol TR? | Ürün arama? | Fiyat? | Görsel? | Bağlantı? | Hesap/anlaşma | Ücretsiz? | Ticari hak | Durum |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.1 | Trendyol Partner API | Yalnızca satıcının kendi ürünleri | Hayır | Kendi | Kendi | — | Satıcı hesabı | Evet | Kendi ürünü | D |
| 1.2 | Trendyol Affiliate (influencer) | Evet | Hayır (uygulamada link üretimi) | Hayır | Hayır | Affiliate link | Influencer başvurusu (takipçi şartı) | Evet | Link paylaşımı | D (veri yok) |
| 1.3 | Admitad / Takefluence | Influencer ajansı; TR/DE teklifleri toplayıcılarda "Closed" (doğrulanmadı) | Feed doğrulanmadı | ? | ? | ? | Yayıncı hesabı | Evet | Program şartları | C |
| 1.4 | Productsup | Trendyol'un feed aracı | — | — | — | — | Trendyol'un ManiCepte'yi export kanalı eklemesi gerekir | ? | Trendyol ile sözleşme | C |
| 1.5 | Sovrn Commerce | `trendyol.com` "Open" listeli; Price Comparison API pazarları: `usd_en, gbp_en, aud_en, cad_en, eur_de, eur_it, eur_fr, eur_es, eur_nl, chf_de` — **TRY yok** | Evet (başlıkta anahtar kelime) | Evet | Evet | Evet (izlenen) | Ücretsiz yayıncı hesabı | Evet (ikincil kaynak) | Sovrn şartları | **D (TR pazarı yok)** |
| 1.6 | Awin / Skimlinks / FlexOffers | Yalnızca Trendyol DE; çoğu "Closed" (doğrulanmadı) | — | — | — | — | Hesap | — | — | D (TR değil) |
| 1.7 | Impact / Partnerize / Involve Asia | Trendyol programı bulunamadı | — | — | — | — | — | — | — | D (bulunamadı) |
| 1.8 | Akakçe / Cimri / Epey | Kendi toplama altyapıları; herkese açık API/feed bulunamadı | — | — | — | — | İş ortaklığı | ? | ? | Doğrulanmadı |
| 1.9 | Bing Web Search API | — | — | — | — | — | — | — | — | D (11 Ağu 2025'te kapandı) |
| 1.10 | Google Custom Search JSON API | — | — | — | — | — | — | — | — | D (yeni müşteriye kapalı, 1 Oca 2027'de kapanıyor) |

## Faz 2 — Açık web indeksleri

| # | Test | Sonuç |
|---|---|---|
| 2.1 | Common Crawl CDX (`CC-MAIN-2026-34`, `www.trendyol.com/apple/` prefix) | Tek kayıt; Common Crawl'ın kendi tarayıcısı **403** almış. Dizin pratikte boş → D |
| 2.2 | Internet Archive | Trendyol robots.txt: `User-agent: ia_archiver / archive.org_bot` → `Disallow: /` → D (istek atılmadı) |

## Faz 3 — Trendyol'un kendi yayınladığı makine-okunur kaynaklar (Node'dan erişilebilir)

| # | Test | Sonuç |
|---|---|---|
| 3.1 | Node → `robots.txt`, `sitemap_index.xml` | **200** (HTML sayfaların aksine) |
| 3.2 | `sitemap_index.xml` içeriği (TR) | 337 `sitemap_products*.xml`, 6 `sitemap_search_combinations*`, 3 `sitemap_search_with_attributes*`, `sitemap_brands`, `sitemap_categories`, 3 `special_landing`, `seller_store`, `custom_sitemap` |
| 3.3 | Arama kombinasyonu + öznitelik + marka sitemap'leri | **360.772** liste sayfası adresi (ör. `iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551`, `siyah-kadin-elbise-x-r14-g1-c56`); robots ile serbest; her biri ~20 MB/41 bin URL |
| 3.4 | Ürün sitemap'i (`sitemap_products337.xml`) | 45 MB, 24.115 ürün; her ürün: `loc` (marka/ürün-slug-p-id) + 3–4 `image:image` (`image:loc` = gerçek CDN görseli, `image:title` = slug, `image:caption` = "slug marka \| Trendyol"). **Fiyat, stok, lastmod yok** |
| 3.5 | Ürün sitemap bölümleme (dosya 1, 150, 300) | Her dosya ~24,1 bin ürün, kimlik aralığı ~75 bin → ~1,21 milyar, markalar karışık → hash bölümleme; sorgu için tüm dizin gerekir. Toplam ≈ 337 × 24,1 bin ≈ **8,1 milyon ürün**, ≈ 15 GB XML |
| 3.6 | `cdn.dsmcdn.com` görsel, Node HEAD | **200** `image/jpeg`, `Access-Control-Allow-Origin: *`; CDN robots.txt `Allow: /` |
| 3.7 | Ürün sayfası meta (kaydedilmiş HTML) | JSON-LD `Product.offers.price` + `priceCurrency=TRY`; gömülü JSON'da `merchant.name`, `inStock`, `stockStatus`; Open Graph'ta fiyat yok; oEmbed/RSS yok |

## Faz 4 — Liste sayfası keşfi (dal `research/trendyol-landing-discovery`)

Kod: `packages/core/src/trendyol-landing/`. Sorgu → 360 bin liste sayfası
dizini → en uygun 1–3 sayfa → gömülü JSON → ürün eşleştirme.

| Sorgu | Seçilen sayfa (çevrimdışı çözüm) | Gerçek Chrome doğrulaması |
|---|---|---|
| iPhone 16 Pro 128 GB | `iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551` | 36 ürün, 0 aksesuar; 2 doğru eşleşme (Çöl/Siyah Titanyum, 124.999,00 TRY, görsel, url) |
| Siyah kadın elbise | `siyah-kadin-elbise-x-r14-g1-c56` | 36 elbise (Trendyol filtresi); başlıkta "kadın" yalnızca 12/36 → sayfa kapsamı kuralı eklendi |
| Adidas Samba | `adidas-x-b33` (model sayfası yok) | İlk 36 içinde ≥8 gerçek "adidas Samba" (ör. Samba OG W 7.999 TL) |
| Sony WH-1000XM5 | `sony-x-b795` (genel marka sayfası) | Faz 5'te çözüldü |
| Nike Air Force 1 | `air-force-x-b187724` (**yanlış**: "Air Force" ayrı marka) | Faz 5'te çözüldü |

Üretim engeli: liste sayfasını Node okuyamıyor (0.4), tarayıcı okuyamıyor (0.7).

## Faz 5 — Arama terimi açılış sayfaları (`sitemap_special_landing1..3.xml`)

| # | Test | Sonuç |
|---|---|---|
| 5.1 | Node → 3 dosya | 200; **94.777** `-y-s<id>` sayfası (Trendyol'un SEO arama terimi sayfaları), ör. `nike-air-force-1-y-s8056`, `sony-wh-1000xm5-kulaklik-y-s76666`, `adidas-samba-y-s10410`; robots ile serbest |
| 5.2 | `custom_sitemap.xml` | 4.866 blog sayfası (`/s/...-blog`) — ürün verisi yok |
| 5.3 | Birleşik dizin (filtre + marka + arama terimi) | **455.549** liste sayfası; 5 sorgunun 5'i doğru ilk adaya çözülüyor |

Gerçek Chrome doğrulaması (normal ziyaret, CAPTCHA yok; kod `discover.ts` ile aynı kurallar):

| Sorgu | Sayfa | Listelenen | Doğru eşleşme | Örnek (ad · fiyat · görsel · url) |
|---|---|---|---|---|
| iPhone 16 Pro 128 GB | `iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551` | 36 | 2 | Apple iPhone 16 Pro 128GB Çöl Titanyum · 124.999 TL · cdn.dsmcdn.com · `/apple/iphone-16-pro-128gb-col-titanyum-p-857296094` |
| Adidas Samba | `adidas-samba-y-s10410` | 36 | 36 | adidas Samba OG Unisex Beyaz Sneaker · 4.799,40 TL · `/adidas/samba-og-unisex-beyaz-sneaker-p-5999429` |
| Siyah kadın elbise | `siyah-kadin-elbise-x-r14-g1-c56` | 36 | 36 (Trendyol filtresi) | World Fashion Trends Siyah Kadın … Mini Elbise · 477,48 TL |
| Sony WH-1000XM5 | `sony-wh-1000xm5-kulaklik-y-s76666` | 8 | 6 | Sony Wh-1000xm5 … Kulaklık-siyah · 23.949 TL · `/sony/wh-1000xm5-…-siyah-p-312097758` |
| Nike Air Force 1 | `nike-air-force-1-y-s8056` | 36 | 13 | Nike Air force 1'07 beyaz ünisex Sneaker · 6.502,80 TL · `/nike/air-force-1-07-beyaz-unisex-sneaker-p-977783209` |

Canlı veride bulunan ve düzeltilen hatalar:
- "kablo" kökü "kablosuz" kulaklığı eliyordu; `-li/-lu/-siz/-suz` sıfat ekleri artık aksesuar sayılmıyor, "cam" kökü ("çamaşır") kaldırıldı.
- `-y-s` sayfaları filtre değil arama sonucu: "WH-1000XM5" sayfasında kulak içi "WF-1000XM5" vardı; sayfa kapsamı yalnızca `-x-` sayfalarında kullanılıyor.

**Bu doğrulama tarayıcıda yapıldı; ManiCepte sunucusu (Node) aynı sayfaları 403 ile alıyor.**

## Faz 6 — Ürün sitemap metadata dizini (fiyatsız, Node'dan erişilebilir)

Kod: `product-index.ts` (bellek içi ters dizin), CLI `scripts/trendyol-product-index-cli.ts`.

Örneklem: 13/337 dosya (337, 7, 31, 58, 84, 111, 139, 166, 193, 221, 248, 276, 305) = 313.473 ürün (%3,9). Dizin kurma 1,8 sn; sorgu ≤12 ms.

| Sorgu | Örneklemde | Tüm dizin tahmini | Not |
|---|---|---|---|
| iPhone 16 Pro 128 GB | 0 | ? | Örneklemde yalnızca 2 "yenilenmiş" kayıt vardı (doğru elendi); tam dizin gerekli |
| Adidas Samba | 26 | ~674 | ör. `adidas/samba-og-kadin-beyaz-krem-spor-ayakkabi-p-921855308`, görsel var |
| Siyah kadın elbise | 345 | ~8.943 | başlıkta üç sözcük birden geçenler |
| Sony WH-1000XM5 | 0 | ? | Örneklemde yalnızca WH-1000XM6 vardı |
| Nike Air Force 1 | 23 | ~596 | ör. `nike/air-force-1-07-erkek-sneaker-ayakkabi-p-872413360`; "Air Force" markası doğru elendi |

Tam dizin indirmesi bu oturumda başlatıldı (6 sn aralık, 403/429'da durur, kaldığı yerden devam eder).
Dizin bu yöntemle **fiyat/stok vermez**; başlık slug'dan gelir (Türkçe karakter yok: "Col" = "Çöl").

## Faz 7 — Fiyata meşru erişim: Cloudflare doğrulanmış bot / Web Bot Auth (yalnızca belge incelemesi)

Kaynak: developers.cloudflare.com "Verified bots", "Web Bot Auth", "IP validation",
"Block AI bots" (Ekim 2026 sürümleri; bir alt ajan tarafından okundu).

- Şartlar: dürüst kimlik (Web Bot Auth imzası **veya** yayınlanmış sabit IP listesi + sabit UA
  **veya** reverse DNS); robots.txt'e ve crawl-delay'e uymak; "reasonable request rates";
  `node-fetch` gibi genel UA'lar reddedilir. En az trafik hacmi ve ücret belirtilmemiş.
- Başvuru: Cloudflare hesabında **BotBase submission form**; durum: Waiting For Review / Accepted / Rejected.
- Web Bot Auth: Ed25519 anahtar, `/.well-known/http-message-signatures-directory` (imzalı JWKS),
  her istekte `Signature-Agent`, `Signature-Input` (`tag="web-bot-auth"`), `Signature`;
  test: `https://crawltest.com/cdn-cgi/web-bot-auth`.
- **Erişim garantisi yok**: BotBase türlerinden **Data Collection** = "Price scraping,
  competitive intelligence gathering…"; site sahipleri doğrulanmış botları türe göre
  engelleyebilir ve WAF kurallarında `cf.bot_management.verified_bot` kullanabilir.
  Trendyol'un bu türe politikası bilinmiyor.
- Sonuç: ücretsiz ve yapılabilir bir **ön koşul**, ama tek başına çözüm değil; Trendyol'un
  izni ve ticari kullanım onayı yine gerekli → sınıf **C**.

## Faz 8 — Sitemap güncelliği

| # | Test | Sonuç |
|---|---|---|
| 8.1 | `sitemap_index.xml` iki okuma (aynı gün, saatler arayla) | 352 TR sitemap'in **hepsi** aynı `lastmod` = `2026-10-11T16:39:34Z`; değişiklik yok → toplu (muhtemelen günlük) üretim. Ürün sitemap'lerinde ürün başına `lastmod` yok |
| 8.2 | Günlük ürün değişim oranı | **Ölçülmedi** — sonraki oturumda: ertesi gün `sitemap_products337.xml` indirilip bugünkü kopyayla (`$TEMP/typrod/`) karşılaştırılacak |
